const API_BASE = "https://api.frame.io/v2";

class FrameIoClient {
  constructor(token, accountId, teamId) {
    this.apiToken = token;
    this.accountId = accountId;
    this.teamId = teamId;
    this.headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    };
  }

  async _fetchWithRetry(url, options = {}, maxRetries = 3) {
    let attempt = 0;
    while (true) {
      try {
        const response = await fetch(url, options);
        if (response.status !== 429) {
          if (!response.ok) {
            console.error(`Error: ${response.status} - ${await response.text()} for ${url}`);
          }
          return response;
        }

        if (attempt >= maxRetries)
          throw new Error(`Rate limit exceeded for ${options.method || "GET"} ${url}`);

        await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000));
        attempt++;
      } catch (err) {
        console.error(`Fetch failed: ${err.message}`);
        throw err;
      }
    }
  }

  async listProjects() {
    const teamsRes = await this._fetchWithRetry(`${API_BASE}/teams`, { headers: this.headers });
    if (!teamsRes.ok) throw new Error("Failed to get teams");
    const teams = await teamsRes.json();

    let projects = [];
    for (let team of teams) {
      const res = await this._fetchWithRetry(`${API_BASE}/teams/${team.id}/projects?filter[archived]=all`, { headers: this.headers });
      if (res.ok) {
        const list = await res.json();
        projects.push(...list.map(p => ({ id: p.id, name: p.name })));
      }
    }
    return projects;
  }

  async getProject(projectId) {
    const res = await this._fetchWithRetry(`${API_BASE}/projects/${projectId}`, { headers: this.headers });
    if (!res.ok) throw new Error("Failed to get project");
    return res.json();
  }

  async listFoldersRecursive(folderId) {
    const res = await this._fetchWithRetry(`${API_BASE}/assets/${folderId}/children?type=folder`, { headers: this.headers });
    if (!res.ok) throw new Error(`Failed to list subfolders for folder ${folderId}`);
    const folders = await res.json();

    let allFolders = folders.map(f => ({ id: f.id, name: f.name }));

    for (let folder of folders) {
      const subfolders = await this.listFoldersRecursive(folder.id);
      allFolders = allFolders.concat(subfolders);
    }

    return allFolders;
  }

  async listAssets(folderId) {
    const res = await this._fetchWithRetry(`${API_BASE}/assets/${folderId}/children?type=file`, { headers: this.headers });
    if (!res.ok) throw new Error(`Failed to list assets for folder ${folderId}`);
    const assets = await res.json();

    return assets.map(a => ({ id: a.id, name: a.name }));
  }

  async createReviewLink(projectId, assetIds, name = "Riggg Review Link") {
    const res = await this._fetchWithRetry(`${API_BASE}/projects/${projectId}/review_links`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name, expires_at: "2025-04-04T21:31:01.164615Z" })
    });
    if (!res.ok) throw new Error("Failed to create review link");
    const link = await res.json();

    const addRes = await this._fetchWithRetry(`${API_BASE}/review_links/${link.id}/assets`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ asset_ids: assetIds })
    });
    if (!addRes.ok) throw new Error("Failed to add assets to review link");

    return link;
  }

  async listReviewLinks(projectId) {
    const res = await this._fetchWithRetry(`${API_BASE}/projects/${projectId}/review_links`, { headers: this.headers });
    if (!res.ok) throw new Error("Failed to list review links");
    return res.json();
  }

  async getFullHierarchyWithAssets(projectId) {
    const project = await this.getProject(projectId);
    const root = project.root_asset_id;

    const folders = await this.listFoldersRecursive(root);

    const hierarchy = [];
    for (let folder of folders) {
      const assets = await this.listAssets(folder.id);
      hierarchy.push({
        folder: { id: folder.id, name: folder.name },
        assets
      });
    }

    return {
      project: { id: project.id, name: project.name },
      hierarchy
    };
  }

  async createReviewLinksForAssets(projectId) {
    const hierarchy = await this.getFullHierarchyWithAssets(projectId);

    const reviewLinks = [];
    for (let folder of hierarchy.hierarchy) {
      for (let asset of folder.assets) {
        const link = await this.createReviewLink(projectId, [asset.id], `Review Link for ${asset.name}`);
        reviewLinks.push({ asset: asset.name, link });
      }
    }

    return reviewLinks;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const projectId = url.searchParams.get("project_id");

    const client = new FrameIoClient(
      env.FRAMEIO_TOKEN,
      env.FRAMEIO_ACCOUNT_ID,
      env.FRAMEIO_TEAM_ID
    );

    try {
      if (path === "/projects") {
        return new Response(JSON.stringify(await client.listProjects()), { headers: { "Content-Type": "application/json" } });
      }

      if (path === "/review-links") {
        return new Response(JSON.stringify(await client.listReviewLinks(projectId)), { headers: { "Content-Type": "application/json" } });
      }

      if (path === "/create-review-links") {
        const reviewLinks = await client.createReviewLinksForAssets(projectId);
        return new Response(JSON.stringify(reviewLinks), { headers: { "Content-Type": "application/json" } });
      }

      return new Response("OK: Frame.io Worker is up", { status: 200 });
    } catch (err) {
      console.error("Worker Error:", err.stack || err.message);
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  }
};
