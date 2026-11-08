// A simulated network for the tests: it records each call and answers with the
// first rule that matches, a later rule first; anything else is 404. Nothing here
// is a real token.
export class Net {
  calls = [];
  rules = [];

  /** Answer the calls whose method and address match. */
  on(method, pattern, answer) {
    this.rules.unshift({ method, pattern, answer });
    return this;
  }

  fetch = async (url, init = {}) => {
    const call = {
      method: init.method ?? "GET",
      url: String(url),
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    this.calls.push(call);
    for (const rule of this.rules) {
      const matches =
        typeof rule.pattern === "string"
          ? call.url.endsWith(rule.pattern)
          : rule.pattern.test(call.url);
      if (rule.method === call.method && matches) {
        return rule.answer(call);
      }
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };

  /** The calls whose address ends with path. */
  to(path) {
    return this.calls.filter((call) => call.url.endsWith(path));
  }
}

export const json = (value, status = 200) => Response.json(value, { status });

export const OWNER = "monalisa";
export const REPO = "monalisa/demo";
export const ITEM = "i0123456789abcde";
