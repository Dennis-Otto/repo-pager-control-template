// The check of the set-up of a control repository, which the workflow Check the
// set-up (setup.yml) runs by hand: every secret and variable that a copy needs,
// PAGER_MODEL and PAGER_LIMITS, the slug of PAGER_APP, what PAGER_FIX_TOKEN may do
// here, the health of the pager as the workflow Health asks for it, and the two
// files of the set-up. Each item gets one line of the summary: what is set and
// works, or what is wrong and how to fix it. No Claude runs here: the job after
// this one asks Claude for two words, on the runner of the jobs of Claude.
//
// No secret goes into the summary or the log: the check says only whether one is
// set, and what GitHub and the pager answered with it.
import { limitsOf, Refusal } from "./core.mjs";
import { GitHub, GitHubError } from "./github.mjs";
import {
  askPager,
  expiryOf,
  problems as healthProblems,
  TOKEN_DAYS,
} from "./health.mjs";
import { SETTINGS, settingsOf, short } from "./template.mjs";

const DAY = 24 * 60 * 60 * 1000;

/** The file that a copy deletes, since the template keeps its actions current. */
export const DEPENDABOT = ".github/dependabot.yml";

/** The secrets and variables that a copy needs, and how to set each. */
export const NEEDED = [
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    kind: "secret",
    how: 'run claude setup-token and set what it prints with gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$CONTROL"',
  },
  {
    name: "PAGER_CONTROL_SECRET",
    kind: "secret",
    how: 'set CONTROL_SECRET of your Worker with gh secret set PAGER_CONTROL_SECRET -R "$CONTROL"',
  },
  {
    name: "PAGER_URL",
    kind: "variable",
    how: 'set the address of your Worker with gh variable set PAGER_URL -R "$CONTROL" --body "$WORKER"',
  },
  {
    name: "PAGER_APP",
    kind: "variable",
    how: 'set the name in the address of your app, github.com/apps/NAME, with gh variable set PAGER_APP -R "$CONTROL" --body NAME',
  },
  {
    name: "PAGER_FIX_TOKEN",
    kind: "secret",
    how: 'make a fine-grained token for the repositories of the pager and this one, with Contents, Pull requests and Workflows read and write, and set it with gh secret set PAGER_FIX_TOKEN -R "$CONTROL"',
  },
];

/** The days left until a day, from now, as the check Health counts them. */
function daysUntil(day, now) {
  return Math.ceil((Date.parse(`${day}T00:00:00Z`) - now) / DAY);
}

/** Each needed secret and variable: set, or how to set it. */
function needed(set) {
  return NEEDED.map(({ name, kind, how }) =>
    set[name] === true
      ? { what: name, ok: true, state: "set" }
      : {
          what: name,
          ok: false,
          state: `The ${kind} ${name} isn't set: ${how}.`,
        },
  );
}

/** PAGER_MODEL and PAGER_LIMITS, as the job prepare reads them. */
function tuning(model, limits) {
  try {
    if (model.trim() === "" && limits.trim() === "") {
      return {
        what: "PAGER_MODEL and PAGER_LIMITS",
        ok: true,
        state:
          "not set: every kind of job runs with the limits of the template",
      };
    }
    const tuned = limitsOf({ model, limits });
    const each = Object.entries(tuned)
      .map(
        ([kind, set]) =>
          `${kind} ${set.model} at ${set.effort}, ${set.budget} dollars, ${set.turns === "" ? "no limit of" : set.turns} turns`,
      )
      .join("; ");
    return { what: "PAGER_MODEL and PAGER_LIMITS", ok: true, state: each };
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }
    return {
      what: "PAGER_MODEL and PAGER_LIMITS",
      ok: false,
      state: `${error.message}. Every job is held until it is fixed: correct the variable, or delete it for the limits of the template.`,
    };
  }
}

/**
 * The app of PAGER_APP: GitHub knows an app by that slug. A private app shows only
 * to a token of its owner, so PAGER_FIX_TOKEN asks when it is set.
 */
async function app(slug, api, owned) {
  const what = "The app of PAGER_APP";
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    return {
      what,
      ok: false,
      state: `${JSON.stringify(slug.slice(0, 40))} isn't the slug of an app, the lower-case name in its address github.com/apps/NAME: set that with gh variable set PAGER_APP.`,
    };
  }
  try {
    const found = await api.get(`/apps/${slug}`);
    return {
      what,
      ok: true,
      state: `GitHub knows ${slug}, ${found.name}: its events start the jobs of Claude`,
    };
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    const hint = owned
      ? ""
      : " A private app shows only to a token of its owner: set PAGER_FIX_TOKEN and run this again.";
    return {
      what,
      ok: false,
      state:
        error.status === 404
          ? `GitHub knows no app ${slug}: set PAGER_APP to the name in the address of your app, github.com/apps/NAME.${hint}`
          : `GitHub didn't say whether the app ${slug} exists: ${error.message}.${hint}`,
    };
  }
}

/**
 * What PAGER_FIX_TOKEN may do here: GET /repos of this repository shows whether it
 * may push, and its header the day on which the token expires, as Health reads it.
 * Returns the line and the day, for the health of the pager.
 */
async function fixToken(token, repo, fetcher, now) {
  const what = "PAGER_FIX_TOKEN on this repository";
  let response;
  try {
    response = await new GitHub(token, fetcher).request(
      "GET",
      `/repos/${repo}`,
    );
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    const why = {
      401: "GitHub refuses it: it expired or was revoked. Make a new one and set it with gh secret set PAGER_FIX_TOKEN",
      403: `GitHub refuses it for ${repo}: ${error.message}. Give it this repository, with Contents, Pull requests and Workflows read and write`,
      404: `it doesn't reach ${repo}: add this repository to the token in your fine-grained tokens, with Contents, Pull requests and Workflows read and write`,
    }[error.status];
    return {
      line: {
        what,
        ok: false,
        state: `${why ?? `GitHub didn't answer for ${repo}: ${error.message}`}.`,
      },
    };
  }
  const expires = expiryOf(
    response.headers.get("github-authentication-token-expiration"),
  );
  const answer = await response.json();
  const day =
    expires === null ? "has no day of expiry" : `expires on ${expires}`;
  if (answer?.permissions?.push !== true) {
    return {
      expires,
      line: {
        what,
        ok: false,
        state: `It reads ${repo} but may not write to it: give it Contents, Pull requests and Workflows read and write; it ${day}.`,
      },
    };
  }
  if (expires !== null && daysUntil(expires, now) <= TOKEN_DAYS) {
    return {
      expires,
      line: {
        what,
        ok: false,
        state: `It ${day}: make a new one and set it with gh secret set PAGER_FIX_TOKEN.`,
      },
    };
  }
  return {
    expires,
    line: {
      what,
      ok: true,
      state: `writes to ${repo} and ${day}. GitHub shows no other permission of a token: Pull requests shows with the first pull request of a fix, Workflows with that of the workflow Template`,
    },
  };
}

/** The health of the pager, signed, as the workflow Health asks for it. */
async function pager({ url, secret, expires, fetcher, now, sleep }) {
  const what = "The pager";
  if (url === "" || secret === "") {
    return [
      {
        what,
        ok: false,
        state:
          "Not asked: it needs PAGER_URL and PAGER_CONTROL_SECRET, which the lines above name.",
      },
    ];
  }
  let health;
  try {
    health = await askPager({
      url,
      secret,
      body: {
        type: "health",
        ...(expires === undefined ? {} : { tokens: { fix: expires } }),
      },
      fetcher,
      now,
      sleep,
    });
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }
    return [{ what, ok: false, state: error.message }];
  }
  const found = healthProblems(health, now());
  if (found.length === 0) {
    return [
      {
        what,
        ok: true,
        state:
          "answers its health, signed: its schedule runs, Telegram takes the bot and GitHub its app",
      },
    ];
  }
  return found.map((problem) => ({ what, ok: false, state: problem }));
}

/** The two files of the set-up: .github/dependabot.yml gone, the settings read. */
function files({ dependabot, settings }) {
  const lines = [
    dependabot
      ? {
          what: DEPENDABOT,
          ok: false,
          state: `It is still here, and its bumps would fight the pull request of the workflow Template: delete it, as Set it up of the README says.`,
        }
      : { what: DEPENDABOT, ok: true, state: "deleted" },
  ];
  if (settings === null) {
    lines.push({
      what: SETTINGS,
      ok: false,
      state:
        "It is missing, and the workflow Template can't run without it: take it from the template again.",
    });
    return lines;
  }
  try {
    const { template, commit } = settingsOf(settings);
    lines.push({
      what: SETTINGS,
      ok: true,
      state:
        commit === ""
          ? `takes ${template}, not yet: the first run of the workflow Template brings it`
          : `takes ${template}, last at ${short(commit)}`,
    });
  } catch (error) {
    // settingsOf refuses whatever doesn't read, with a Refusal alone.
    lines.push({
      what: SETTINGS,
      ok: false,
      state: `${error.message}: correct it, or take it from the template again.`,
    });
  }
  return lines;
}

/**
 * The check of the set-up. `set` says by name which secret and variable is set;
 * the values come only where the check needs them. Returns one line per item, and
 * the problems, of which any fails the run.
 */
export async function doctor({
  set,
  url,
  secret,
  app: slug,
  token,
  workflowToken,
  repo,
  model,
  limits,
  dependabot,
  settings,
  fetcher,
  now,
  sleep,
}) {
  const lines = [...needed(set), tuning(model, limits)];
  if (slug !== "") {
    const owned = token !== "";
    lines.push(
      await app(
        slug,
        new GitHub(owned ? token : workflowToken, fetcher),
        owned,
      ),
    );
  }
  let expires;
  if (token !== "") {
    const fix = await fixToken(token, repo, fetcher, now());
    expires = fix.expires;
    lines.push(fix.line);
  }
  lines.push(
    ...(await pager({ url, secret, expires, fetcher, now, sleep })),
    ...files({ dependabot, settings }),
  );
  return {
    lines,
    problems: lines.filter(({ ok }) => !ok).map(({ state }) => state),
  };
}

/** The lines as the table of the summary of the run. */
export function summaryOf(lines) {
  const rows = lines
    .map(
      ({ what, ok, state }) =>
        `| ${ok ? "✅" : "❌"} | ${what} | ${state.replaceAll("|", "\\|")} |`,
    )
    .join("\n");
  return `### The set-up of this control repository\n\n| | What | State |\n| --- | --- | --- |\n${rows}\n\nThe job after this one asks Claude for two words on the runner of the jobs of Claude. Should it wait with *Waiting for a runner to pick up this job*, your account has no egress-firewall runner: cancel the run and set PAGER_AI_RUNNER, as the README says.\n`;
}
