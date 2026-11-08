// A small client of the API of GitHub, on fetch, which the tests give a simulated
// network. It names the status and GitHub's message of a refusal, never a token.

/** A refusal of GitHub: its status and its message. */
export class GitHubError extends Error {
  constructor(status, detail) {
    super(`GitHub answered ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export class GitHub {
  constructor(token, fetcher = fetch, base = "https://api.github.com") {
    this.token = token;
    this.fetch = fetcher;
    this.base = base;
  }

  async request(method, path, body) {
    const response = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "repo-pager-control",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      let detail = text.slice(0, 200);
      try {
        detail = JSON.parse(text).message ?? detail;
      } catch {
        // Not JSON: the start of the text says enough.
      }
      throw new GitHubError(response.status, detail);
    }
    return response;
  }

  async json(method, path, body) {
    const response = await this.request(method, path, body);
    return response.status === 204 ? null : response.json();
  }

  get(path) {
    return this.json("GET", path);
  }

  post(path, body) {
    return this.json("POST", path, body);
  }

  async text(path) {
    return (await this.request("GET", path)).text();
  }

  async graphql(query, variables) {
    const answer = await this.post("/graphql", { query, variables });
    if (Array.isArray(answer?.errors) && answer.errors.length > 0) {
      throw new GitHubError(200, String(answer.errors[0]?.message));
    }
    return answer.data;
  }
}
