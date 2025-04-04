export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const searchParams = url.searchParams;

    const FRAMEIO_API_TOKEN = env.FRAMEIO_API_TOKEN;
    const FRAMEIO_ACCOUNT_ID = env.FRAMEIO_ACCOUNT_ID;

    const headers = {
      Authorization: `Bearer ${FRAMEIO_API_TOKEN}`,
      "Content-Type": "application/json"
    };

    // 1️⃣ GET PROJECTS (just names + ids, paginated)
    if (pathname === "/get-projects") {
      const page = searchParams.get("page") || 1;
      const pageSize = 50;

      const teamsRes = await fetch(`https://api.frame.io/v2/accounts/${FRAMEIO_ACCOUNT_ID}/teams`, { headers });
      if (!teamsRes.ok) return new Response("Failed to get teams", { status: 500 });
      const teams = await teamsRes.json();
      const teamId = teams[0].id;

      const res = await fetch(`https://api.frame.io/v2/teams/${teamId}/projects?page_size=${pageSize}&page=${page}`, { headers });
      const projects = await res.json();
      const minimal = projects.map(p => ({ name: p.name, id: p.id }));

      return new Response(JSON.stringify(minimal), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2️⃣ GET FOLDERS IN PROJECT
    if (pathname === "/get-project-folders") {
      const projectId = searchParams.get("project_id");
      if (!projectId) return new Response("Missing project_id", { status: 400 });

      const res = await fetch(`https://api.frame.io/v2/projects/${projectId}/folders`, { headers });
      const folders = await res.json();
      const minimal = folders.map(f => ({ name: f.name, id: f.id }));

      return new Response(JSON.stringify(minimal), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3️⃣ GET SUBFOLDERS IN FOLDER
    if (pathname === "/get-subfolders") {
      const folderId = searchParams.get("folder_id");
      if (!folderId) return new Response("Missing folder_id", { status: 400 });

      const res = await fetch(`https://api.frame.io/v2/assets/${folderId}/children`, { headers });
      const children = await res.json();
      const foldersOnly = children
        .filter(c => c.type === "folder")
        .map(f => ({ name: f.name, id: f.id }));

      return new Response(JSON.stringify(foldersOnly), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 4️⃣ GET FILES + REVIEW LINKS IN A FOLDER
    if (pathname === "/get-files-and-review-links") {
      const folderId = searchParams.get("folder_id");
      if (!folderId) return new Response("Missing folder_id", { status: 400 });

      const filesRes = await fetch(`https://api.frame.io/v2/assets/${folderId}/children`, { headers });
      const assets = await filesRes.json();
      const filesOnly = assets.filter(a => a.type === "file");

      const result = [];

      for (const file of filesOnly) {
        const reviewsRes = await fetch(`https://api.frame.io/v2/assets/${file.id}/review_links`, { headers });
        const links = await reviewsRes.json();

        result.push({
          name: file.name,
          id: file.id,
          review_links: links.map(l => ({ id: l.id, url: l.public_url }))
        });
      }

      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // ❌ Catch all
    return new Response("Not Found", { status: 404 });
  }
}
