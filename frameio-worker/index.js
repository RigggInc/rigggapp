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
        if (response.status !== 429) return response;

        if (attempt >= maxRetries)
          throw new Error(`Rate limit exceeded for ${options.method || "GET"} ${url}`);

        await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000));
        attempt++;
      } catch (err) {
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
      const res = await this._fetchWithRetry(`${API_BASE}/teams/${team.id}/projects`, { headers: this.headers });
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

  async listFolders(projectId) {
    const project = await this.getProject(projectId);
    const root = project.root_asset_id;
    const res = await this._fetchWithRetry(`${API_BASE}/assets/${root}/children?type=folder`, { headers: this.headers });
    if (!res.ok) throw new Error("Failed to list folders");
    const folders = await res.json();
    return folders.map(f => ({ id: f.id, name: f.name }));
  }

  async getAssetWithHierarchy(assetId) {
    const res = await this._fetchWithRetry(`${API_BASE}/assets/${assetId}`, { headers: this.headers });
    if (!res.ok) throw new Error("Failed to get asset");
    const asset = await res.json();
    const path = [];
    let parent = asset.parent_asset_id;
    const project = await this.getProject(asset.project_id);
    while (parent && parent !== project.root_asset_id) {
      const pRes = await this._fetchWithRetry(`${API_BASE}/assets/${parent}`, { headers: this.headers });
      if (!pRes.ok) break;
      const pAsset = await pRes.json();
      path.push(pAsset.name);
      parent = pAsset.parent_asset_id;
    }
    return { asset, folderPath: path.reverse() };
  }

  async searchAssets(query, projectId = null) {
    const body = {
      account_id: this.accountId,
      q: query,
      page_size: 25
    };
    if (projectId) {
      body.filter = { project_id: { op: "eq", value: projectId } };
    }
    const res = await this._fetchWithRetry(`${API_BASE}/search/library`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("Search failed");
    return res.json();
  }

  async listReviewLinks(projectId) {
    const res = await this._fetchWithRetry(`${API_BASE}/projects/${projectId}/review_links`, { headers: this.headers });
    if (!res.ok) throw new Error("Failed to list review links");
    return res.json();
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

  async createPresentationLink(assetId) {
    const asset = await (await this._fetchWithRetry(`${API_BASE}/assets/${assetId}`, { headers: this.headers })).json();
    const me = await (await this._fetchWithRetry(`${API_BASE}/me`, { headers: this.headers })).json();
    const res = await this._fetchWithRetry(`${API_BASE}/assets/${assetId}/presentations`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        project_id: asset.project_id,
        owner_id: me.id,
        asset_id: assetId,
        name: "Riggg Presentation"
      })
    });
    if (!res.ok) throw new Error("Failed to create presentation link");
    return res.json();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const projectId = url.searchParams.get("project_id");
    const assetId = url.searchParams.get("asset_id");
    const assetName = url.searchParams.get("asset_name");
    const query = url.searchParams.get("q");

    const client = new FrameIoClient(
      env.FRAMEIO_TOKEN,
      env.FRAMEIO_ACCOUNT_ID,
      env.FRAMEIO_TEAM_ID
    );

    try {
      if (path === "/projects") {
        return new Response(JSON.stringify(await client.listProjects()), { headers: { "Content-Type": "application/json" } });
      }

      if (path.startsWith("/projects/") && path.endsWith("/folders")) {
        const pid = path.split("/")[2];
        return new Response(JSON.stringify(await client.listFolders(pid)), { headers: { "Content-Type": "application/json" } });
      }

      if (path.startsWith("/assets/") && path.endsWith("/hierarchy")) {
        const aid = path.split("/")[2];
        return new Response(JSON.stringify(await client.getAssetWithHierarchy(aid)), { headers: { "Content-Type": "application/json" } });
      }

      if (path === "/search") {
        return new Response(JSON.stringify(await client.searchAssets(query, projectId)), { headers: { "Content-Type": "application/json" } });
      }

      if (path === "/review-link") {
        const results = await client.searchAssets(assetName, projectId);
        const link = await client.createReviewLink(projectId, results[0].id);
        return new Response(JSON.stringify(link), { headers: { "Content-Type": "application/json" } });
      }

      if (path === "/presentation") {
        return new Response(JSON.stringify(await client.createPresentationLink(assetId)), { headers: { "Content-Type": "application/json" } });
      }

      if (path === "/project-review-links") {
        return new Response(JSON.stringify(await client.listReviewLinks(projectId)), { headers: { "Content-Type": "application/json" } });
      }

      return new Response("OK: Frame.io Worker is up", { status: 200 });
    } catch (err) {
      console.error("Worker Error:", err);
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  }
};
