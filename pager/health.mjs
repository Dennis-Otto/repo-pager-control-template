// The daily check of the pager (health.yml): the pager writes only when something
// needs the maintainer, so a quiet day looks the same whether all is well or the pager is
// dead. This asks its Worker, signed, for its health and finds what is wrong: no
// answer, a schedule that stopped, Telegram or GitHub that refuse it, a webhook of
// Telegram that fails, or a token that expires within a week. It reads the day of
// PAGER_FIX_TOKEN from GitHub and sends it along, for the reminder of the pager. A
// failed run reaches the maintainer by GitHub's own notification, which works also when
// Telegram or the Worker is what broke. No token goes into the log or the summary.
import { PASSING, pause, Refusal, signature } from "./core.mjs";
import { GitHub, GitHubError } from "./github.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** How old the last run of the schedule may be: it runs every 15 minutes. */
export const SCHEDULE_WITHIN = HOUR;
/** How far back an error of the webhook of Telegram counts. */
export const WEBHOOK_WITHIN = DAY;
/** How many days before a token expires the check fails. */
export const TOKEN_DAYS = 7;

/** The names of the tokens, as the maintainer sets them, and how to renew each. */
const TOKENS = {
  claude: {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    renew:
      "renew it with claude setup-token and gh secret set CLAUDE_CODE_OAUTH_TOKEN, then change CLAUDE_TOKEN_EXPIRES in wrangler.jsonc of the pager",
  },
  user: {
    name: "GITHUB_USER_TOKEN",
    renew:
      "renew it on GitHub and set it with npx wrangler secret put GITHUB_USER_TOKEN",
  },
  fix: {
    name: "PAGER_FIX_TOKEN",
    renew: "renew it on GitHub and set it with gh secret set PAGER_FIX_TOKEN",
  },
};

/**
 * The day in UTC that the header github-authentication-token-expiration names,
 * such as "2026-12-03 10:00:00 UTC" or "2026-12-03 02:00:00 -0800"; null without
 * it or for one that can't be read, as the pager reads it.
 */
export function expiryOf(header) {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(
      (header ?? "").trim(),
    );
  if (match === null) {
    return null;
  }
  const zone = match[3] ?? "UTC";
  const offset = ["UTC", "Z"].includes(zone)
    ? "Z"
    : zone.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const time = Date.parse(`${match[1]}T${match[2]}${offset}`);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

/**
 * What GitHub says of PAGER_FIX_TOKEN: { expires } with the day on which it
 * expires, or null for a token without one; { refused: true } for a 401; or
 * { note } without the token, or when GitHub didn't answer.
 */
export async function fixToken(token, fetcher) {
  if (token === "") {
    return {
      note: "PAGER_FIX_TOKEN isn't set, so 🛠 Start fix opens no pull request.",
    };
  }
  try {
    // GET /rate_limit counts against no limit of the API.
    const response = await new GitHub(token, fetcher).request(
      "GET",
      "/rate_limit",
    );
    return {
      expires: expiryOf(
        response.headers.get("github-authentication-token-expiration"),
      ),
    };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) {
      return { refused: true };
    }
    return {
      note: `GitHub didn't say when PAGER_FIX_TOKEN expires: ${error.message}.`,
    };
  }
}

/** Whether an answer of the pager is its health, as far as the check reads it. */
function isHealth(value) {
  return (
    typeof value?.telegram === "object" &&
    value.telegram !== null &&
    typeof value.github === "object" &&
    value.github !== null
  );
}

/**
 * Why the pager refused the check, by its status below 500 and the start of its
 * answer: the secret is named only for a 401, the one status of a wrong signature.
 */
function refusal(status, answer) {
  if (status === 400) {
    return "The pager doesn't take the body health: deploy a Worker that knows it.";
  }
  const hint =
    status === 401
      ? " PAGER_CONTROL_SECRET must equal CONTROL_SECRET of the Worker, and the clock of the runner may be off by five minutes at most."
      : "";
  return `The pager refused the check with ${status}: ${answer}.${hint}`;
}

/**
 * Ask the pager for its health, signed, three times at most after a failure of the
 * network, of the Worker or a passing one of Cloudflare in front of it, such as its
 * rate limit, with the wait that a header Retry-After asks for. Returns its answer, or throws a refusal that says why
 * none came.
 */
export async function askPager({
  url,
  secret,
  body,
  fetcher,
  now,
  sleep,
  tries = 3,
}) {
  if (url === "" || secret === "") {
    throw new Refusal(
      "The variable PAGER_URL or the secret PAGER_CONTROL_SECRET isn't set, so the pager can't be checked.",
    );
  }
  const text = JSON.stringify(body);
  const address = `${url.replace(/\/+$/, "")}/control`;
  let last = "";
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    let response = null;
    try {
      response = await fetcher(address, {
        method: "POST",
        headers: signature(secret, text, Math.floor(now() / 1000)),
        body: text,
      });
      const answer = await response.text();
      if (response.ok) {
        let health = null;
        try {
          health = JSON.parse(answer);
        } catch {
          // Not JSON: no health either.
        }
        if (!isHealth(health)) {
          throw new Refusal(
            "The pager answered something other than its health: is its Worker older than the body health?",
          );
        }
        return health;
      }
      if (response.status < 500 && !(response.status in PASSING)) {
        throw new Refusal(refusal(response.status, answer.slice(0, 200)));
      }
      last =
        response.status in PASSING
          ? `it answered ${response.status}, ${PASSING[response.status]}`
          : `it answered ${response.status}: ${answer.slice(0, 200)}`;
    } catch (error) {
      if (error instanceof Refusal) {
        throw error;
      }
      last = `the network failed: ${error.message}`;
    }
    if (attempt < tries) {
      await sleep(pause(response?.headers, 2000 * attempt, now()));
    }
  }
  throw new Refusal(`The pager didn't answer after ${tries} tries: ${last}.`);
}

/** The days left until a day, from now, as the pager counts them. */
function daysUntil(day, now) {
  return Math.ceil((Date.parse(`${day}T00:00:00Z`) - now) / DAY);
}

/** What is wrong with the pager, by its answer; an empty list when all is well. */
export function problems(health, now) {
  const found = [];
  const ran = Date.parse(health.schedule ?? "");
  if (Number.isNaN(ran)) {
    found.push(
      "The schedule of the pager never ran to its end: does the Worker still have its cron trigger? Its log in Cloudflare says why a run failed.",
    );
  } else if (ran < now - SCHEDULE_WITHIN) {
    found.push(
      `The schedule of the pager last ran to its end at ${health.schedule}, more than an hour ago: does the Worker still have its cron trigger? Its log in Cloudflare says why a run failed.`,
    );
  }
  const { telegram, github } = health;
  if (telegram.ok !== true) {
    found.push(
      `Telegram refuses the bot: ${telegram.error}. Is TELEGRAM_BOT_TOKEN of the Worker still valid?`,
    );
  } else {
    if (telegram.webhook !== true) {
      found.push(
        "No webhook of Telegram is set, so the bot gets no update: set it again, as step 5 of docs/setup.md of the pager says.",
      );
    }
    const failed = Date.parse(telegram.lastError?.at ?? "");
    if (!Number.isNaN(failed) && failed >= now - WEBHOOK_WITHIN) {
      found.push(
        `The webhook of Telegram failed at ${telegram.lastError.at}: ${telegram.lastError.message}. ${telegram.pending} update(s) wait.`,
      );
    }
  }
  if (github.ok !== true) {
    found.push(
      `GitHub refuses the app of the pager: ${github.error}. Are GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY of the Worker still right?`,
    );
  }
  for (const [token, { name, renew }] of Object.entries(TOKENS)) {
    const state = health.tokens?.[token];
    if (typeof state?.refused === "string") {
      found.push(
        `GitHub refuses ${name} since ${state.refused}: it expired or was revoked; ${renew}.`,
      );
    } else if (
      typeof state?.expires === "string" &&
      daysUntil(state.expires, now) <= TOKEN_DAYS
    ) {
      found.push(`${name} expires on ${state.expires}: ${renew}.`);
    }
  }
  return found;
}

/** The health as a table of the summary of the run. */
export function summary(health, notes) {
  const { telegram } = health;
  const rows = [
    ["Last run of the schedule", health.schedule ?? "never"],
    [
      "Telegram",
      telegram.ok === true
        ? `takes the bot; webhook ${telegram.webhook === true ? "set" : "not set"}, ${telegram.pending} update(s) waiting${telegram.lastError === undefined ? "" : `, last error at ${telegram.lastError.at}`}`
        : `refuses: ${telegram.error}`,
    ],
    [
      "GitHub",
      health.github.ok === true
        ? "takes the app"
        : `refuses: ${health.github.error}`,
    ],
    ...Object.entries(TOKENS).map(([token, { name }]) => {
      const state = health.tokens?.[token];
      let value = "unknown";
      if (typeof state?.refused === "string") {
        value = `refused since ${state.refused}`;
      } else if (state !== undefined) {
        value =
          state.expires === null ? "no day" : `expires on ${state.expires}`;
      }
      return [name, value];
    }),
  ];
  const table = rows
    .map(([what, value]) => `| ${what} | ${value} |`)
    .join("\n");
  const extra = notes.map((note) => `- ${note}\n`).join("");
  return `### The health of the pager\n\n| What | State |\n| --- | --- |\n${table}\n${extra === "" ? "" : `\n${extra}`}`;
}

/**
 * The check: the day of PAGER_FIX_TOKEN, the health of the pager, and what is
 * wrong. Returns the summary and the problems, of which any fails the run.
 */
export async function check({ url, secret, token, fetcher, now, sleep }) {
  const fix = await fixToken(token, fetcher);
  const found = [];
  const notes = fix.note === undefined ? [] : [fix.note];
  if (fix.refused === true) {
    found.push(
      "GitHub refuses PAGER_FIX_TOKEN: it expired or was revoked. Make a new one and set it with gh secret set PAGER_FIX_TOKEN.",
    );
  }
  const body = {
    type: "health",
    ...("expires" in fix ? { tokens: { fix: fix.expires } } : {}),
  };
  const health = await askPager({ url, secret, body, fetcher, now, sleep });
  found.push(...problems(health, now()));
  return { summary: summary(health, notes), problems: found };
}
