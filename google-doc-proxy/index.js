export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    const { docName, destinationFolderId, recordId } = await request.json();

    // Fetch data from Airtable
    async function fetchAirtableData(recordId, env) {
      if (!recordId) {
        throw new Error("Missing recordId");
      }

      const sessionUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_SESSION_TABLE_NAME}/${recordId}`;
      console.log("Airtable Session URL:", sessionUrl);

      const sessionRes = await fetch(sessionUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      if (!sessionRes.ok) {
        const error = await sessionRes.json();
        console.error("Airtable Error Response:", error);
        throw new Error(`Failed to fetch session data from Airtable: ${error.error?.message || "Unknown error"}`);
      }

      const sessionData = await sessionRes.json();
      console.log("Session Data:", sessionData);

      return sessionData.fields;
    }

    // Fetch Airtable data
    const sessionFields = await fetchAirtableData(recordId, env);

    // Map Airtable fields to placeholders
    const placeholders = {
      "{{session_TitleLabel}}": sessionFields.session_TitleLabel || "",
      "{{session_IdAndDateCode}}": sessionFields.session_IdAndDateCode || "",
      "{{session_Season}}": sessionFields.session_Season || "",
      "{{session_Episode}}": sessionFields.session_Episode || "",
      "{{session_GoogleCalendarURL}}": sessionFields.session_GoogleCalendarURL || "",
      "{{session_SessionRawStorageURL}}": sessionFields.session_SessionRawStorageURL || "",
      "{{session_FrameReviewLink}}": sessionFields.session_FrameReviewLink || ""
    };

    // Map placeholders to links
    const linkMap = {
      "{{session_GoogleCalendarURL}}": "Google Calendar Event",
      "{{session_SessionRawStorageURL}}": "Session Raw Storage",
      "{{session_FrameReviewLink}}": "Frame Review"
    };

    console.log("Placeholders:", placeholders);

    // Decoding the Google Service Account base64 string to JSON
    // This function decodes a base64 string to JSON
    function decodeBase64ToJson(base64) {
      const binaryString = atob(base64.replace(/[\r\n]+/g, ""));
      const byteArray = new Uint8Array([...binaryString].map(char => char.charCodeAt(0)));
      return JSON.parse(new TextDecoder().decode(byteArray));
    }

    function decodePEMToBinary(pem) {
      // Remove PEM headers/footers and decode Base64
      const base64 = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, "")
        .replace(/-----END PRIVATE KEY-----/, "")
        .replace(/\n/g, "")
        .replace(/\r/g, "");
      const binaryString = atob(base64);
      const binaryArray = new Uint8Array([...binaryString].map(char => char.charCodeAt(0)));
      return binaryArray.buffer; // Return ArrayBuffer for crypto.subtle.importKey
    }

    // Decode the service account
    console.log("GOOGLE_SERVICE_ACCOUNT (Base64):", env.GOOGLE_SERVICE_ACCOUNT);
    const SERVICE_ACCOUNT = decodeBase64ToJson(env.GOOGLE_SERVICE_ACCOUNT);
    console.log("Decoded Service Account:", SERVICE_ACCOUNT);

    if (!SERVICE_ACCOUNT.private_key || !SERVICE_ACCOUNT.client_email) {
      throw new Error("Invalid service account: Missing private_key or client_email");
    }

    const jwtHeader = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const jwtClaimSet = {
      iss: SERVICE_ACCOUNT.client_email,
      scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now
    };

    const toBase64 = obj =>
      btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    const encoder = new TextEncoder();
    const keyBinary = decodePEMToBinary(SERVICE_ACCOUNT.private_key);

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBinary,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const unsignedJWT = toBase64(jwtHeader) + "." + toBase64(jwtClaimSet);
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, encoder.encode(unsignedJWT));
    const signedJWT =
      unsignedJWT +
      "." +
      btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_"); // Fixed: Added the missing closing parenthesis

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJWT}`
    });

    const tokenJson = await tokenRes.json();
    console.log("Token Response:", tokenJson);

    if (!tokenRes.ok) {
      throw new Error(`Failed to fetch access token: ${tokenJson.error}`);
    }

    const accessToken = tokenJson.access_token;

    const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`, {
      method: "GET"
    });

    const tokenInfoJson = await tokenInfoRes.json();
    console.log("Token Info Response:", tokenInfoJson);

    if (!tokenInfoRes.ok) {
      throw new Error(`Failed to fetch token info: ${tokenInfoJson.error_description || "Unknown error"}`);
    }

    // Check if the required scopes are present
    const requiredScopes = [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents"
    ];

    const tokenScopes = tokenInfoJson.scope.split(" ");
    const missingScopes = requiredScopes.filter(scope => !tokenScopes.includes(scope));

    if (missingScopes.length > 0) {
      throw new Error(`Access token is missing required scopes: ${missingScopes.join(", ")}`);
    }

    console.log("Access token has all required scopes.");

    const TEMPLATE_DOC_ID = "1AoNqYQLtBD3jO4zd9w3dgD5i9lnkV3FklZ1tUmz0GqY"; // Template document ID

    // Test access to the template document
    const testAccessRes = await fetch(`https://www.googleapis.com/drive/v3/files/${TEMPLATE_DOC_ID}?supportsAllDrives=true`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const testAccessJson = await testAccessRes.json();
    console.log("Test Access Response:", testAccessJson);

    if (!testAccessRes.ok) {
      throw new Error(`Service account cannot access the document: ${testAccessJson.error?.message || "Unknown error"}`);
    }

    // Test access to the destination folder
    const testFolderAccessRes = await fetch(`https://www.googleapis.com/drive/v3/files/${destinationFolderId}?supportsAllDrives=true`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const testFolderAccessJson = await testFolderAccessRes.json();
    console.log("Test Folder Access Response:", testFolderAccessJson);

    if (!testFolderAccessRes.ok) {
      throw new Error(`Service account cannot access the destination folder: ${testFolderAccessJson.error?.message || "Unknown error"}`);
    }

    // Copy template doc
    const copyRes = await fetch(`https://www.googleapis.com/drive/v3/files/${TEMPLATE_DOC_ID}/copy?supportsAllDrives=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: docName, parents: [destinationFolderId] })
    });

    const copyJson = await copyRes.json();
    console.log("Copy Response:", copyJson);

    if (!copyRes.ok) {
      throw new Error(`Failed to copy document: ${copyJson.error?.message || "Unknown error"}`);
    }

    const newDocId = copyJson.id;
    if (!newDocId) {
      throw new Error("Failed to retrieve new document ID from copy response");
    }

    const DEBUG = false; // Set to true for detailed logs

    // Fetch the document structure
    const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${newDocId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const docJson = await docRes.json();

    if (DEBUG) {
      console.log("Document Structure:", JSON.stringify(docJson, null, 2));
    } else {
      console.log("Document Title:", docJson.title);
    }

    if (!docRes.ok) {
      throw new Error(`Failed to fetch document structure: ${docJson.error?.message || "Unknown error"}`);
    }

    // Log only critical milestones
    console.log("Document fetched successfully:", `https://docs.google.com/document/d/${newDocId}/edit`);

    // Replace placeholders and apply links
    const batchRequests = [];

    // Step 1: Replace placeholders
    for (const [tag, value] of Object.entries(placeholders)) {
      if (!value) {
        console.warn(`Skipping placeholder: ${tag} because its value is invalid`);
        continue;
      }

      // Convert value to string to ensure compatibility with Google Docs API
      const replaceText = String(linkMap[tag] || value);

      // Replace placeholder text
      batchRequests.push({
        replaceAllText: {
          containsText: { text: tag, matchCase: true },
          replaceText: replaceText // Ensure replaceText is a string
        }
      });
    }

    // Send batchUpdate request to replace placeholders
    const replaceRes = await fetch(`https://docs.googleapis.com/v1/documents/${newDocId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requests: batchRequests })
    });

    const replaceJson = await replaceRes.json();
    if (!replaceRes.ok) {
      throw new Error(`Failed to replace placeholders: ${replaceJson.error?.message || "Unknown error"}`);
    }

    // Step 2: Fetch the updated document structure
    const updatedDocRes = await fetch(`https://docs.googleapis.com/v1/documents/${newDocId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const updatedDocJson = await updatedDocRes.json();
    if (!updatedDocRes.ok) {
      throw new Error(`Failed to fetch updated document structure: ${updatedDocJson.error?.message || "Unknown error"}`);
    }

    // Step 3: Find ranges for hyperlinks
    function findTextRanges(content, text) {
      const ranges = [];

      function traverseElements(elements, parentStartIndex = 0) {
        for (const element of elements) {
          if (element.startIndex !== undefined && element.endIndex !== undefined) {
            const elementText = element.textRun?.content || "";
            const startIndex = parentStartIndex + element.startIndex;

            if (elementText.includes(text)) {
              const textStart = startIndex + elementText.indexOf(text);
              const textEnd = textStart + text.length;
              ranges.push({ startIndex: textStart, endIndex: textEnd });
            }
          }

          // Traverse nested elements (e.g., tables, paragraphs)
          if (element.table) {
            for (const row of element.table.tableRows) {
              for (const cell of row.tableCells) {
                traverseElements(cell.content, parentStartIndex);
              }
            }
          }

          if (element.paragraph) {
            traverseElements(element.paragraph.elements, parentStartIndex);
          }
        }
      }

      traverseElements(content);
      return ranges;
    }

    // Step 4: Apply hyperlinks
    const linkRequests = [];
    for (const [tag, url] of Object.entries(placeholders)) {
      if (tag in linkMap) {
        const displayText = linkMap[tag];
        const ranges = findTextRanges(updatedDocJson.body.content, displayText);

        if (ranges.length === 0) {
          console.warn(`No ranges found for text: "${displayText}"`);
          continue;
        }

        for (const range of ranges) {
          linkRequests.push({
            updateTextStyle: {
              range: {
                startIndex: range.startIndex,
                endIndex: range.endIndex
              },
              textStyle: {
                link: { url: url }
              },
              fields: "link"
            }
          });
        }
      }
    }

    // Send batchUpdate request to apply hyperlinks
    const linkRes = await fetch(`https://docs.googleapis.com/v1/documents/${newDocId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requests: linkRequests })
    });

    const linkJson = await linkRes.json();
    if (!linkRes.ok) {
      throw new Error(`Failed to apply hyperlinks: ${linkJson.error?.message || "Unknown error"}`);
    }

    console.log("Hyperlinks applied successfully.");

    return new Response(
      JSON.stringify({ docUrl: `https://docs.google.com/document/d/${newDocId}/edit` }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
};

function findPlaceholderRanges(content, placeholder) {
  const ranges = [];

  function traverseElements(elements, startIndex = 0) {
    for (const element of elements) {
      if (element.textRun && element.textRun.content.includes(placeholder)) {
        const start = startIndex + element.startIndex;
        const end = start + placeholder.length;
        ranges.push({ startIndex: start, endIndex: end });
      }

      if (element.table) {
        for (const row of element.table.tableRows) {
          for (const cell of row.tableCells) {
            traverseElements(cell.content, cell.startIndex);
          }
        }
      }

      if (element.paragraph) {
        traverseElements(element.paragraph.elements, element.startIndex);
      }
    }
  }

  traverseElements(content);
  return ranges;
}
