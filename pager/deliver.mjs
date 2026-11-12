// The answer goes back to the pager's Worker, at /control, signed with
// PAGER_CONTROL_SECRET over the time and the body, never to Telegram itself: the
// Worker alone holds the token of the bot, keeps the state of each thing and shows
// the answer in its message, escaped, with a button of its allowlist at most.
import { PASSING, pause, signature } from "./core.mjs";

/** What each refusal of the pager means, for the log of the run. */
const REFUSALS = {
  400: "the pager doesn't take this body: do the control repository and the Worker speak the same contract?",
  401: "the pager refused the signature: PAGER_CONTROL_SECRET must equal CONTROL_SECRET of the Worker, and the clock of the runner may be off by five minutes at most",
  404: "the pager has no such thing now",
  409: "the thing changed in between, so the pager left it as it is",
  413: "the answer is too long for the pager",
  422: "the pager found that the translation doesn't fit the notes, which its check here should have found first: do the control repository and the Worker check the same?",
};

/** Wait, between two tries. */
export function wait(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

/**
 * Send a body to the pager, again after a failure of the network, of the Worker or a
 * passing one of Cloudflare in front of it, such as its rate limit, with a new
 * signature each time and the wait that a header Retry-After asks for. Returns whether it arrived, whether a failure
 * should fail the run, and what to say in the log.
 */
export async function deliver({
  url,
  secret,
  body,
  fetcher = fetch,
  now = Date.now,
  sleep = wait,
  tries = 3,
}) {
  if (url === "" || secret === "") {
    return {
      sent: false,
      fatal: false,
      note: "Not sent: the variable PAGER_URL or the secret PAGER_CONTROL_SECRET isn't set; the summary of the run shows the answer.",
    };
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
      const answer = (await response.text()).slice(0, 200);
      if (response.ok) {
        return {
          sent: true,
          fatal: false,
          note: `The pager answered: ${answer}`,
        };
      }
      if (response.status === 404 || response.status === 409) {
        return {
          sent: false,
          fatal: false,
          note: `Not shown: ${REFUSALS[response.status]}.`,
        };
      }
      if (response.status < 500 && !(response.status in PASSING)) {
        return {
          sent: false,
          fatal: true,
          note: `Not sent: ${REFUSALS[response.status] ?? `the pager answered ${response.status}: ${answer}`}.`,
        };
      }
      last =
        response.status in PASSING
          ? `the pager answered ${response.status}, ${PASSING[response.status]}`
          : `the pager answered ${response.status}: ${answer}`;
    } catch (error) {
      last = `the network failed: ${error.message}`;
    }
    if (attempt < tries) {
      await sleep(pause(response?.headers, 2000 * attempt, now()));
    }
  }
  return {
    sent: false,
    fatal: true,
    note: `Not sent after ${tries} tries: ${last}.`,
  };
}
