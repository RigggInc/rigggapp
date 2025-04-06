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
        await new Promise(resolve => setTimeout(resolve, 100)); // Add a 100ms delay
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

  async listTopLevelFolders(projectId) {
    const project = await this.getProject(projectId);
    const root = project.root_asset_id;

    if (!root) throw new Error(`Project ${projectId} has no root_asset_id`);

    const res = await this._fetchWithRetry(`${API_BASE}/assets/${root}/children?type=folder`, {
      headers: this.headers
    });

    if (!res.ok) throw new Error("Failed to list top-level folders");
    const folders = await res.json();

    return folders.map(f => ({ id: f.id, name: f.name }));
  }

  async listFoldersRecursive(folderId) {
    console.log(`Fetching subfolders for folder ID: ${folderId}`);
    
    const res = await this._fetchWithRetry(`${API_BASE}/assets/${folderId}/children?type=folder`, { headers: this.headers });
    if (!res.ok) {
      console.error(`Failed to fetch subfolders for folder ID: ${folderId}`);
      console.error(`Response: ${await res.text()}`);
      throw new Error(`Failed to list subfolders for folder ${folderId}`);
    }
    
    const folders = await res.json();
    console.log(`Subfolders for ${folderId}:`, folders);

    if (!folders || folders.length === 0) {
      console.log(`No subfolders found for folder ${folderId}`);
      return [];
    }

    let allFolders = folders.map(f => ({ id: f.id, name: f.name }));

    for (let folder of folders) {
      const subfolders = await this.listFoldersRecursive(folder.id);
      allFolders = allFolders.concat(subfolders);
    }

    return allFolders;
  }

  async getAllFolders(projectId, recursive = false) {
    const project = await this.getProject(projectId);
    const root = project.root_asset_id;

    if (!root) throw new Error(`Project ${projectId} has no root_asset_id`);

    if (recursive) {
      return await this.listFoldersRecursive(root);
    } else {
      return await this.listTopLevelFolders(projectId);
    }
  }

  async listAssets(folderId) {
    console.log(`Fetching assets for folder ID: ${folderId}`);
    
    const res = await this._fetchWithRetry(`${API_BASE}/assets/${folderId}/children?type=file`, { headers: this.headers });
    if (!res.ok) {
      console.error(`Failed to fetch assets for folder ID: ${folderId}`);
      console.error(`Response: ${await res.text()}`);
      throw new Error(`Failed to list assets for folder ${folderId}`);
    }
    
    const assets = await res.json();
    console.log(`Assets for ${folderId}:`, assets);

    return assets.map(a => ({ id: a.id, name: a.name, type: a.type }));
  }

  async getFullHierarchyWithAssets(projectId) {
    const project = await this.getProject(projectId);
    const root = project.root_asset_id;

    if (!root) throw new Error(`Project ${projectId} has no root_asset_id`);

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

  async createReviewLink(projectId, assetIds, name = "Review Link") {
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
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const projectId = url.searchParams.get("project_id");
    const recursive = url.searchParams.get("recursive") === "true";

    const client = new FrameIoClient(
      env.FRAMEIO_TOKEN,
      env.FRAMEIO_ACCOUNT_ID,
      env.FRAMEIO_TEAM_ID
    );

    try {
      if (path === "/projects") {
        const projects = await client.listProjects();
        return new Response(JSON.stringify(projects), { headers: { "Content-Type": "application/json" } });
      }

      if (path === "/folders") {
        if (!projectId) {
          return new Response("Missing project_id", { status: 400 });
        }
        const folders = await client.getAllFolders(projectId, recursive);
        return new Response(JSON.stringify(folders), { headers: { "Content-Type": "application/json" } });
      }

      return new Response("OK: Frame.io Worker is up", { status: 200 });
    } catch (err) {
      console.error("Worker Error:", err.stack || err.message);
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  }
};
