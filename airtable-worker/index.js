export default {
  async fetch(request, env, ctx) {
    const authHeader = request.headers.get("x-worker-auth");
    if (authHeader !== env.WORKER_AUTH_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    const AIRTABLE_BASE_ID = env.AIRTABLE_BASE_ID;
    const AIRTABLE_API_KEY = env.AIRTABLE_API_KEY;

    const headers = {
      "Authorization": `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json"
    };


    // 🔍 Get schema
    if (pathname === "/get-schema") {
      const airtableSchemaUrl = `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`;
      try {
        const response = await fetch(airtableSchemaUrl, { method: "GET", headers });
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
          status: 200
        });
      } catch (err) {
        return new Response("Failed to fetch schema: " + err.message, { status: 500 });
      }
    }

    // 📄 Get records
    if (pathname === "/get-records") {
      const table = url.searchParams.get("table");
      if (!table) return new Response("Missing 'table' query parameter", { status: 400 });

      const maxRecords = parseInt(url.searchParams.get("maxRecords") || "10", 10);
      const pageSize = parseInt(url.searchParams.get("pageSize") || "10", 10);
      const filterByFormula = url.searchParams.get("filterByFormula");
      const sort = url.searchParams.get("sort");
      const view = url.searchParams.get("view");
      const fields = url.searchParams.getAll("fields");

      const airtableUrl = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`);
      airtableUrl.searchParams.append("maxRecords", maxRecords);
      airtableUrl.searchParams.append("pageSize", pageSize);
      if (filterByFormula) airtableUrl.searchParams.append("filterByFormula", filterByFormula);
      if (sort) {
        airtableUrl.searchParams.append("sort[0][field]", sort);
        airtableUrl.searchParams.append("sort[0][direction]", "desc");
      }
      if (view) airtableUrl.searchParams.append("view", view);
      fields.forEach(f => airtableUrl.searchParams.append("fields[]", f));

      try {
        const response = await fetch(airtableUrl.toString(), {
          method: "GET",
          headers
        });
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
          status: 200
        });
      } catch (err) {
        return new Response("Failed to fetch records: " + err.message, { status: 500 });
      }
    }

    // ✏️ Create record (flattened fields with smart Single Select handling)
    if (pathname === "/create-record" && request.method === "POST") {
      try {
        const body = await request.json();
        const { table, ...rest } = body;

        if (!table) {
          return new Response("Missing 'table' in request body", { status: 400 });
        }

        const singleSelectFields = ["session_Type", "session_Stage"];
        const fields = Object.fromEntries(
          Object.entries(rest).map(([key, value]) => {
            if (singleSelectFields.includes(key) && value?.name) {
              return [key, value.name]; // Flatten { name: "Option" } to "Option"
            }
            return [key, value];
          })
        );

        const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
        const response = await fetch(airtableUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ fields })
        });

        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
          status: response.status
        });
      } catch (err) {
        return new Response("Failed to create record: " + err.message, { status: 500 });
      }
    }

    // 🔄 Update record
    if (pathname === "/update-record" && request.method === "PATCH") {
      try {
        const body = await request.json();
        const { table, recordId, ...rest } = body;
        const fields = { ...rest };


        if (!table || !recordId || !fields) {
          return new Response("Missing 'table', 'recordId', or 'fields' in request body", { status: 400 });
        }

        const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`;
        const response = await fetch(airtableUrl, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ fields })
        });

        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
          status: response.status
        });
      } catch (err) {
        return new Response("Failed to update record: " + err.message, { status: 500 });
      }
    }

    // 🚫 Fallback 404
    return new Response("Not Found", { status: 404 });
  }
};
