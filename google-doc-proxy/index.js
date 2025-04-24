// /worker.js
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    const { docName, destinationFolderId, recordId } = await request.json();

    const sessionFields = await fetchAirtableSession(recordId, env);
    const deliverables = await fetchSessionDeliverables(sessionFields.session_Deliverables, env);
    console.log("Fetched deliverables:", JSON.stringify(deliverables, null, 2));

    const mapping = await loadDeliverableMapping(env);
    const deliverablePlaceholders = buildDeliverablePlaceholders(deliverables, mapping);
    console.log("Deliverable placeholder output:", deliverablePlaceholders);

    const placeholders = {
      ...buildPlaceholders(sessionFields),
      ...deliverablePlaceholders
    };
    const linkMap = buildLinkMap();

    const SERVICE_ACCOUNT = decodeServiceAccount(env.GOOGLE_SERVICE_ACCOUNT);
    const accessToken = await generateAccessToken(SERVICE_ACCOUNT);

    await verifyAccess(accessToken, env.TEMPLATE_DOC_ID, destinationFolderId);

    const newDocId = await copyTemplateDoc(env.TEMPLATE_DOC_ID, docName, destinationFolderId, accessToken);
    console.log("New doc created with ID:", newDocId);

    const docJson = await fetchDocStructure(newDocId, accessToken);

    try {
      await replacePlaceholders(newDocId, placeholders, linkMap, accessToken);
      console.log("Placeholders replaced successfully");
    } catch (err) {
      console.error("Error replacing placeholders:", err);
      throw err;
    }

    const updatedDocJson = await fetchDocStructure(newDocId, accessToken);

    try {
      await insertDeliverableImages(newDocId, updatedDocJson.body.content, placeholders.__images || {}, accessToken);
      console.log("Images inserted successfully");
    } catch (err) {
      console.error("Error inserting images:", err);
      throw err;
    }

    try {
      await applyHyperlinks(newDocId, updatedDocJson.body.content, placeholders, linkMap, accessToken);
      console.log("Hyperlinks applied successfully");
    } catch (err) {
      console.error("Error applying hyperlinks:", err);
      throw err;
    }

    return new Response(JSON.stringify({ docUrl: `https://docs.google.com/document/d/${newDocId}/edit` }), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

function buildDeliverablePlaceholders(deliverables, mapping) {
  const output = {};
  const imagePlaceholders = {};

  for (const map of mapping) {
    const filtered = deliverables.filter(d => {
      const types = Array.isArray(d["deliverable_Type"]) ? d["deliverable_Type"] : [d["deliverable_Type"]];
      return types.includes(map.type);
    });

    let match;
    if (map.aspect) {
      match = filtered.find(d => d["deliverable_TemplateAspectRatio"] === map.aspect);
    } else if (map.instance) {
      match = filtered.find(d => Number(d["deliverable_TemplateInstance"]) === map.instance);
    } else {
      match = filtered[0];
    }

    if (!match) {
      console.warn(`No match found for type=${map.type}, aspect=${map.aspect || "-"}, instance=${map.instance || "-"}`);
      continue;
    }
    if (!match[map.field]) {
      console.warn(`Match found but field '${map.field}' missing in:`, match);
      continue;
    }

    const rawValue = match[map.field];
    let value;

    if (Array.isArray(rawValue)) {
      value = rawValue.join("\n");
    } else {
      value = rawValue;
    }

    if ((map.type === "Quote Graphic" || map.type === "Thumbnail") && typeof value === "string") {
      const isCloudflareImage = /https:\/\/imagedelivery\.net\//.test(value);
      if (isCloudflareImage) {
        imagePlaceholders[map.placeholder] = value;
        output[map.placeholder] = "";
      } else {
        console.warn(`Invalid Cloudflare image URL for placeholder '${map.placeholder}':`, value);
      }
      continue;
    }

    output[map.placeholder] = value;
    console.log(`Placeholder: ${map.placeholder} → Value:`, output[map.placeholder]);
  }

  if (Object.keys(imagePlaceholders).length > 0) {
    output.__images = imagePlaceholders;
  }

  return output;
}

async function fetchAirtableSession(recordId, env) {
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_SESSION_TABLE_NAME}/${recordId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) throw new Error("Airtable fetch failed");
  const data = await res.json();
  return data.fields;
}

async function fetchSessionDeliverables(ids, env) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const records = [];
  for (const id of ids) {
    const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Deliverable/${id}`, {
      headers: {
        Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    if (res.ok) {
      const data = await res.json();
      records.push(data.fields);
    }
  }
  return records;
}

function loadDeliverableMapping(env) {
  return [
    { placeholder: "{{deliverable_SessionTitle}}", field: "deliverable_FinalCopy", type: "Title" },
    { placeholder: "{{deliverable_SessionSummary}}", field: "deliverable_FinalCopy", type: "Summary" },
    { placeholder: "{{deliverable_LinkedInPost}}", field: "deliverable_FinalCopy", type: "Text Post" },
    { placeholder: "{{deliverable_ReelCopy1}}", field: "deliverable_FinalCopy", type: "Social Copy for Reel", instance: 1 },
    { placeholder: "{{deliverable_ReelCopy2}}", field: "deliverable_FinalCopy", type: "Social Copy for Reel", instance: 2 },
    { placeholder: "{{deliverable_ReelCopy3}}", field: "deliverable_FinalCopy", type: "Social Copy for Reel", instance: 3 },
    { placeholder: "{{deliverableQuoteGraphic1}}", field: "deliverable_DownloadLink", type: "Quote Graphic", instance: 1 },
    { placeholder: "{{deliverableQuoteGraphic2}}", field: "deliverable_DownloadLink", type: "Quote Graphic", instance: 2 },
    { placeholder: "{{deliverableQuoteGraphic3}}", field: "deliverable_DownloadLink", type: "Quote Graphic", instance: 3 },
    { placeholder: "{{deliverableThumbnail11}}", field: "deliverable_DownloadLink", type: "Thumbnail", aspect: "1:1" },
    { placeholder: "{{deliverableThumbnail169}}", field: "deliverable_DownloadLink", type: "Thumbnail", aspect: "16:9" },
    { placeholder: "{{deliverable_Carousel}}", field: "deliverable_DownloadLink", type: "Carousel" },
    { placeholder: "{{deliverable_Chapters}}", field: "deliverable_FinalCopy", type: "Chapters" },
    { placeholder: "{{deliverable_Transcript}}", field: "deliverable_FinalCopy", type: "Transcript" }
  ];
}

function buildPlaceholders(fields) {
  return {
    "{{session_TitleLabel}}": fields.session_TitleLabel || "",
    "{{session_IdAndDateCode}}": fields.session_IdAndDateCode || "",
    "{{session_Season}}": fields.session_Season || "",
    "{{session_Episode}}": fields.session_Episode || "",
    "{{session_GoogleCalendarURL}}": fields.session_GoogleCalendarURL || "",
    "{{session_SessionRawStorageURL}}": fields.session_SessionRawStorageURL || "",
    "{{session_FrameReviewLink}}": fields.session_FrameReviewLink || ""
  };
}

function buildLinkMap() {
  return {
    "{{session_GoogleCalendarURL}}": "Google Calendar Event",
    "{{session_SessionRawStorageURL}}": "Session Raw Storage",
    "{{session_FrameReviewLink}}": "Frame Review"
  };
}

function decodeServiceAccount(base64) {
  const jsonStr = atob(base64.replace(/\s/g, ""));
  const json = new TextDecoder().decode(new Uint8Array([...jsonStr].map(c => c.charCodeAt(0))));
  return JSON.parse(json);
}

async function generateAccessToken(SERVICE_ACCOUNT) {
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: "RS256", typ: "JWT" };
  const jwtClaimSet = {
    iss: SERVICE_ACCOUNT.client_email,
    scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const toBase64 = obj => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const keyBinary = decodePEMToBinary(SERVICE_ACCOUNT.private_key);
  const cryptoKey = await crypto.subtle.importKey("pkcs8", keyBinary, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsignedJWT = `${toBase64(jwtHeader)}.${toBase64(jwtClaimSet)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsignedJWT));
  const signedJWT = `${unsignedJWT}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJWT}`
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Token error: ${tokenJson.error}`);
  return tokenJson.access_token;
}

function decodePEMToBinary(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s/g, "");
  const binary = atob(base64);
  return new Uint8Array([...binary].map(c => c.charCodeAt(0))).buffer;
}

async function verifyAccess(token, docId, folderId) {
  const headers = { Authorization: `Bearer ${token}` };

  const docRes = await fetch(`https://www.googleapis.com/drive/v3/files/${docId}?supportsAllDrives=true`, {
    method: "GET",
    headers
  });
  const docContentType = docRes.headers.get("content-type") || "";
  const docBody = docContentType.includes("application/json") ? await docRes.json() : await docRes.text();
  console.log("Doc Access Check:", docId, JSON.stringify(docBody));

  const folderRes = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?supportsAllDrives=true`, {
    method: "GET",
    headers
  });
  const folderContentType = folderRes.headers.get("content-type") || "";
  const folderBody = folderContentType.includes("application/json") ? await folderRes.json() : await folderRes.text();
  console.log("Folder Access Check:", folderId, JSON.stringify(folderBody));

  if (!docRes.ok) throw new Error("Doc access denied");
  if (!folderRes.ok) throw new Error("Folder access denied");
}

async function copyTemplateDoc(templateId, name, folderId, token) {
  const copyRes = await fetch(`https://www.googleapis.com/drive/v3/files/${templateId}/copy?supportsAllDrives=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, parents: [folderId] })
  });
  const copyJson = await copyRes.json();
  if (!copyRes.ok) throw new Error(`Copy failed: ${copyJson.error?.message}`);
  return copyJson.id;
}

async function fetchDocStructure(docId, token) {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Fetch doc failed: ${json.error?.message}`);
  return json;
}

async function replacePlaceholders(docId, placeholders, linkMap, token) {
  const imageKeys = Object.keys(placeholders.__images || {});
  const requests = Object.entries(placeholders)
    .filter(([tag]) => tag !== "__images" && !imageKeys.includes(tag))
    .map(([tag, value]) => ({
      replaceAllText: {
        containsText: { text: tag, matchCase: true },
        replaceText: String(linkMap[tag] || value)
      }
    }));

  await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requests })
  });
}



async function applyHyperlinks(docId, content, placeholders, linkMap, token) {
  const requests = [];
  for (const [tag, url] of Object.entries(placeholders)) {
    if (!linkMap[tag]) continue;
    const displayText = linkMap[tag];
    const ranges = findTextRanges(content, displayText);
    for (const range of ranges) {
      requests.push({
        updateTextStyle: {
          range,
          textStyle: { link: { url } },
          fields: "link"
        }
      });
    }
  }

  await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ requests })
  });
}

async function insertDeliverableImages(docId, content, imagePlaceholders, token) {
  const requests = [];

  for (const [tag, url] of Object.entries(imagePlaceholders)) {
    const ranges = findTextRanges(content, tag);
    if (ranges.length === 0) {
      console.warn(`Image placeholder not found in document: ${tag}`);
      continue;
    }

    console.log(`Preparing to insert image for tag '${tag}' with URL: ${url}`);
    console.log(`Found ranges:`, ranges);

    for (const range of ranges) {
      requests.push({ deleteContentRange: { range } });
      requests.push({
        insertInlineImage: {
          location: { index: range.startIndex },
          uri: url,
          objectSize: {
            height: { magnitude: 200, unit: "PT" },
            width: { magnitude: 200, unit: "PT" }
          }
        }
      });
    }
  }

  if (requests.length > 0) {
    console.log(`Sending ${requests.length} image-related batchUpdate requests...`);
    await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requests })
    });
  }
}

function findTextRanges(content, text) {
  const ranges = [];
  function walk(elements) {
    for (const e of elements) {
      if (e.textRun?.content?.includes(text)) {
        const startIndex = e.startIndex + e.textRun.content.indexOf(text);
        ranges.push({ startIndex, endIndex: startIndex + text.length });
      }
      if (e.table) {
        for (const row of e.table.tableRows) {
          for (const cell of row.tableCells) walk(cell.content);
        }
      }
      if (e.paragraph) walk(e.paragraph.elements);
    }
  }
  walk(content);
  return ranges;
}