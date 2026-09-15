/**
 * What each step button DOES when pressed.
 *
 * Pure and separate from `step-run.ts` so the catalogue can be tested: that file
 * is `server-only`, and a `server-only` import throws under `node --test`. The
 * one property worth asserting — that no step in the catalogue can reach the
 * runner without a description of its blast radius — is only checkable here.
 *
 * These are descriptions; the actions live in `step-actions.ts`. The email
 * steps and the payment link are switched off pending explicit enablement, and
 * the route answers a press on one of those with the description below instead
 * of running it — see `step-run.ts`.
 */

/** Which external system a step reaches, and what it does when it gets there. */
export interface StepEffect {
  /** The service that would be called. */
  target: string;
  /** What would happen out there, in one sentence. */
  effect: string;
  /** Can it be taken back once it has happened? */
  reversible: boolean;
  /** The credential it runs on (ONBOARDING_-prefixed in the OS), named so the dependency is concrete. */
  credential: string;
}

const GMAIL = "Gmail (the company service account)";
const GMAIL_CRED = "GOOGLE_OAUTH refresh token for the orchestrator's mailbox";
const BISON_CRED = "EMAILBISON API key for the orchestrator's own account";

/*
 * The fourteen from `steps.ts`, plus the three actions that sit on the same
 * panel and reach just as far: the Stripe payment link, the campaign pause, and
 * the tool's "run every remaining step" chain.
 *
 * `campaign:launch` is the one to read twice.
 */
export const STEP_EFFECTS: Record<string, StepEffect> = {
  "email:welcome": {
    target: GMAIL,
    effect: "sends the welcome email to the client's primary contact, with their onboarding call date",
    reversible: false,
    credential: GMAIL_CRED,
  },
  "email:confirmations": {
    target: GMAIL,
    effect: "emails the campaign copy to the client for approval, and sets copy_status to sent",
    reversible: false,
    credential: GMAIL_CRED,
  },
  "push:client_portal": {
    target: "Client Portal (portal.brokerstaffer.com hub API)",
    effect:
      "creates the client's portal account and its introduction macro, and stores the portal URL — which contains their access token",
    reversible: false,
    credential: "CLIENT_PORTAL hub token",
  },
  "email:how_intros_work": {
    target: GMAIL,
    effect: "sends the 'how introductions work' email to the client",
    reversible: false,
    credential: GMAIL_CRED,
  },
  "email:meet_team": {
    target: GMAIL,
    effect: "sends the 'meet your recruiting team' email, cc'ing the TAC named on this client",
    reversible: false,
    credential: GMAIL_CRED,
  },
  "email:portal": {
    target: GMAIL,
    effect: "emails the client their portal link, which is their access token in a URL",
    reversible: false,
    credential: GMAIL_CRED,
  },
  "email:dnc_reminder": {
    target: GMAIL,
    effect: "asks the client to add their do-not-contact list in the portal",
    reversible: false,
    credential: GMAIL_CRED,
  },
  "build:team": {
    target: "Agent Search database, then the Client Portal",
    effect:
      "DELETES this client's whole orch_client_team list and rebuilds it from agents matching their firm name plus the people named on the intake form, then pushes the result to their portal",
    reversible: false,
    credential: "CLIENT_PORTAL hub token",
  },
  "push:health_dash": {
    target: "Client Health dashboard",
    effect: "registers the client on the Health Dashboard so they appear in the weekly view",
    reversible: false,
    credential: "CLIENT_HEALTH admin credential with write scope",
  },
  "campaign:build": {
    target: "EmailBison",
    effect: "creates a new empty EmailBison campaign for this client and stores its id",
    reversible: false,
    credential: BISON_CRED,
  },
  "build:leads": {
    target: "Agent Search database, then Slack",
    effect:
      "DELETES this client's built lead list and rebuilds it from the 1.17M agent table using their MLS and filters, hands it to the DB app for review, and posts to Slack",
    reversible: false,
    credential: "SLACK bot token (the lead build itself is a database write)",
  },
  "campaign:launch": {
    target: "EmailBison",
    effect:
      "STARTS SENDING. Real email goes to every real estate agent imported into this campaign — typically hundreds. There is no unsend.",
    reversible: false,
    credential: BISON_CRED,
  },
  "email:campaign_launched": {
    target: GMAIL,
    effect: "tells the client their campaign is running",
    reversible: false,
    credential: GMAIL_CRED,
  },
  "email:followup_call": {
    target: GMAIL,
    effect: "sends the Touch Base check-in email, usually about three weeks after onboarding",
    reversible: false,
    credential: GMAIL_CRED,
  },

  /* --- on the same panel, same reach, not in the fourteen ----------------- */

  "campaign:pause": {
    target: "EmailBison",
    effect: "stops the client's campaign sending. The only one of these that undoes something.",
    reversible: true,
    credential: BISON_CRED,
  },
  "payment:link": {
    target: "Stripe, then Gmail",
    effect:
      "creates a live Stripe Payment Link for the amount typed and emails it to the client's primary contact",
    reversible: false,
    credential: "STRIPE_SECRET_KEY, plus the Gmail refresh token",
  },
  "setup:remaining": {
    target: "Client Portal, Gmail, Client Health and EmailBison, in sequence",
    effect:
      "runs the whole set-up chain in one click — portal, four onboarding emails, team push, Health Dash, campaign build. Six external side effects from one press.",
    reversible: false,
    credential: "all of the above at once",
  },
};

/** Every action the step route knows about, whether or not it is in the catalogue. */
export const RUNNABLE_KEYS = Object.keys(STEP_EFFECTS);
