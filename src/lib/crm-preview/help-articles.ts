/*
 * The Help page's 12 articles, from the client's document (4 Nov, the user: "the 12 articles that we need to add in the
 * help section"), corrected on 5 Nov only where they didn't match the portal (the user: "just change that is necessary").
 * The wording is the client's: change it only with their say or the user's. **bold** is the document's own bold; "See
 * <another article's title>" becomes a link where it is drawn (static-pages.tsx).
 */

export type HelpBlock =
  | { p: string }
  | { h: string }
  | { ol: string[] }
  | { ul: string[] }
  | { table: { head: string[]; rows: string[][] } };

export interface HelpArticle {
  slug: string;
  title: string;
  blocks: HelpBlock[];
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: "how-brokerstaffer-works",
    title: "How BrokerStaffer works",
    blocks: [
      { p: "BrokerStaffer reaches the agents you want in your market and sends you the ones who are interested in joining you. You only pay for results." },
      { ol: [
        "**You tell us who to reach.** In setup you pick the agents we email, by location, sales volume, units, years licensed and brokerage. Your own agents and your DNC List are always left out.",
        "**We write your emails from your offer.** You see every email and approve it before anything goes out.",
        "**We reach out and follow up.** Each agent gets a short, personal email, plus follow-ups until they're ready to talk.",
        "**Interested agents come straight to your team.** When an agent replies interested, we email the contacts on your account and add the agent to your Pipeline.",
        "**Your team takes it from there.** You reply to the agent, book the call and track them through to Hired.",
      ] },
      { p: "Every interested agent in your Pipeline comes with their production: sales volume, closed transactions, current brokerage and MLS. Your first interested agents usually arrive within 48 hours of launch." },
    ],
  },
  {
    slug: "your-first-week",
    title: "Your first week",
    blocks: [
      { p: "Your first week is setup, approving your emails, and then your first interested agents. Account setup has five steps. You can click **Save and exit** at any point. Your team and lists are kept, but your offer is saved only when you click **Finish setup**, and setup reopens at step 1." },
      { ol: [
        "**Welcome and your team.** Add the people who work interested agents.",
        "**My Agents.** Find your office under the **Brokerage** filter, tick your agents and add them, or import a CSV. We never email anyone on this list.",
        "**DNC List.** Add referral partners and former agents one by one. To block a whole company, like a sister office, import a CSV: that blocks every agent at its email domain.",
        "**Who we email.** Filter every active agent in your market by location, sales volume, units, years licensed and brokerage, then add the ones you want to your prospects.",
        "**Your offer.** Pick what you give agents who join, like leads, a transaction coordinator, coaching or a competitive split, and tell us in a sentence or two why agents join you. Add anything we should never say, like competitors you don't want named.",
      ] },
      { p: "When you click **Finish setup**, here's what happens next:" },
      { ul: [
        "We write your emails and send them to you for approval.",
        "Once you approve, your campaign goes live.",
        "Agents who reply interested land in your Pipeline, and we email the contacts on your account.",
      ] },
      { p: "Most teams see their first interested agents within 48 hours of launch. Reply to each one quickly, the same day if you can: agents who just said yes are the easiest to book." },
    ],
  },
  {
    slug: "setting-up-your-team",
    title: "Setting up your team",
    blocks: [
      { p: "Your team is everyone at your brokerage who works interested agents, so add the people who will reply and book the call. Interested agents themselves are emailed to the contacts on your account: see Who receives interested agents." },
      { ol: [
        "Go to **Team** in the left menu.",
        "Click **Add member**.",
        "Enter their full name, title, email and phone.",
        "Click **Add member** to save.",
      ] },
      { p: "Adding a whole team at once? Click **Import CSV** and upload a file with each person's name, title, email and phone." },
      { p: "**Who to add.** Recruiters, recruiting managers and the team leader or broker who takes recruiting calls. You can always add more later." },
      { p: "**Who's on by default.** New members are active. For what that means, see Turning a teammate on or off." },
    ],
  },
  {
    slug: "moving-agents-between-stages",
    title: "Moving agents between stages",
    blocks: [
      { p: "Every interested agent starts in your first stage: **Interested** on pay-per-lead plans, otherwise **Introduction**. Move them forward as your conversations progress so your whole team can see where each one stands." },
      { p: "Your default stages, in order: Introduction, Phone Screen Scheduled, Phone Screen, Interview Scheduled, Interview, Hired. On pay-per-lead plans, Interested takes the place of Introduction." },
      { h: "Move one agent" },
      { ul: [
        "On the **Board**, drag the agent's card to the new stage.",
        "Or in **List** view, click the stage on the agent's row and pick the new one.",
      ] },
      { h: "Move several agents at once" },
      { ol: [
        "Switch to **List** view and tick the agents you want.",
        "Click **Move to...** and pick a stage.",
      ] },
      { p: "To select everyone, tick the box at the top of the list, then click **Select all** to include every page." },
      { p: "**Tags, for agents who aren't moving forward.** Stages move agents forward through hiring. For anything else, add a tag instead: Nurture, Not a Fit, No Response, Phone screen no show or Interview no show. Tagging an agent doesn't move them out of their stage. Tick the agents and click **Add tag...**, or add one from the agent's profile." },
      { p: "**Change your stages.** Click **Manage stages** at the top of the Pipeline to rename, reorder, show or hide stages, or add your own. Changes apply to everyone on your team. Custom stages are for your workflow and don't change your reporting." },
    ],
  },
  {
    slug: "replying-to-an-interested-agent",
    title: "Replying to an interested agent",
    blocks: [
      { p: "You reply to interested agents by email, straight from your inbox. When an agent says they're interested, we email the contacts on your account (see Who receives interested agents). Hit reply all on that email and the conversation continues with the agent directly." },
      { p: "**Reply fast.** An agent who just said yes is at their most interested. Aim to reply the same day, ideally within the hour, and offer two or three times for a quick call." },
      { p: "**See the conversation in the CRM.** In **Pipeline**, click **Conversation** under the agent's name. You'll see every email between us and the agent, and the date it was forwarded to your team. This is a read-only copy of the thread; replies always go by email." },
      { p: "**Check their numbers before you reply.** On the **Board**, click the agent's card to open their profile: sales volume, closed transactions, average sales price, current brokerage, office city and MLS. Mentioning one of these shows you did your homework." },
      { h: "Keep your team in the loop." },
      { ul: [
        "**Assign it.** Tick the agent and click **Assign to...** so everyone knows who's handling them.",
        "**Add a note.** Click **Add note** on the agent's row to log what they said, like what they asked about or when they want to talk. Everyone on your team sees it.",
        "**Move the stage.** Once the call is booked, move them to Phone Screen Scheduled.",
      ] },
    ],
  },
  {
    slug: "board-and-list-views",
    title: "Board and list views",
    blocks: [
      { p: "Your Pipeline has two views of the same agents. Switch between them with **View as: Board / List** at the top of the page; nothing changes when you switch." },
      { table: {
        head: ["", "Board", "List"],
        rows: [
          ["Best for", "Seeing where everyone stands at a glance", "Working through agents and making changes in bulk"],
          ["Layout", "One column per stage, with a card per agent", "One row per agent, grouped by month"],
          ["Shows", "Name, sales volume, brokerage, date and source", "Name, email, phone, office, stage, owner and date"],
          ["Totals", "Agents and total sales volume per stage", "Agents per month"],
          ["Actions", "Click a card to open the agent's profile, or Conversation to read the emails", "Tick rows to move, tag, assign, copy names or emails, export or delete"],
        ],
      } },
      { p: "**Both views** show your total number of agents and their total sales volume at the top, and use the same date filter (for example, All time)." },
      { p: "**Adding agents yourself.** Met an agent outside BrokerStaffer? Click **Add agent** to add them by hand, or **Upload CSV** to add many. Their source shows as Client, so you can tell them apart from agents we sent you." },
    ],
  },
  {
    slug: "adding-your-own-agents",
    title: "Adding your own agents",
    blocks: [
      { p: "My Agents is the list of agents already at your brokerage. We never email anyone on it, so add your whole roster before your campaign goes live." },
      { h: "Add one agent" },
      { ol: [
        "Go to **My Agents** in the left menu.",
        "Click **Add agent**.",
        "Enter their full name, email and phone.",
        "Click **Add**.",
      ] },
      { p: "**Add many at once.** Click **Import CSV** and upload your roster. See Importing a CSV for the columns we read." },
      { p: "**During setup** you can also find your office under the **Brokerage** filter, tick your agents and add them in one go. That's the fastest way if your roster is large." },
      { p: "**Keep it current.** Add new hires as they join, so they never get an email from your own campaign. To take someone off, tick them and click **Delete selected**. Click **Export CSV** any time for a copy of the list." },
    ],
  },
  {
    slug: "blocking-a-company-or-domain",
    title: "Blocking a company or domain",
    blocks: [
      { p: "Add a company to your DNC List and we'll never email any agent at it. Use this for sister offices, referral partners and any brokerage you've agreed not to recruit from." },
      { ol: [
        "Go to **DNC List** in the left menu.",
        "Click **Import CSV**.",
        "Choose a CSV file with a row for each company: its name, its email domain (for example c21connect.com) and company in the kind column. Add a notes column if you like, such as \"Sister office\".",
      ] },
      { p: "We block every email at that domain, whatever provider it's on. If an agent there uses a personal email, like Gmail, add them as an agent too, just to be sure." },
      { p: "**Blocking one person instead.** Click **Add to DNC** and enter their name and email. Former agents and friends at other brokerages are common ones." },
      { p: "**What you'll see.** The top of the DNC List shows how many agents and how many companies are blocked. Everyone on the list, and every agent at those companies, is left out of all outreach." },
    ],
  },
  {
    slug: "importing-a-csv",
    title: "Importing a CSV",
    blocks: [
      { p: "You can import a CSV to add many people at once to My Agents, your DNC List or your Team. Every list works the same way: click **Import CSV** at the top of the page and choose your file." },
      { p: "Your headers don't need to match exactly. For example, Full Name, Email Address and Phone Number all work." },
      { table: {
        head: ["List", "Columns we read"],
        rows: [
          ["My Agents", "name, email, phone"],
          ["DNC List", "name, email, phone, brokerage, domain, kind (agent or company), notes"],
          ["Team", "name, title, email, phone"],
        ],
      } },
      { p: "**DNC List imports** can mix agents and companies in one file. Put agent or company in the kind column. Every row needs a name. For a company row we block its domain at every email provider; if the row only has an email, we take the domain from it." },
      { h: "Tips for a clean import" },
      { ul: [
        "Export your roster from your CRM or MLS tool as a CSV, not an Excel file.",
        "Keep one person per row, with the column names in the first row.",
        "An email address matters most: it's how we make sure we never contact someone. Rows without one are harder to match (a Team row without one is skipped).",
        "Add new people as they come up, so the list never falls behind.",
      ] },
    ],
  },
  {
    slug: "adding-a-teammate",
    title: "Adding a teammate",
    blocks: [
      { p: "Add a teammate whenever someone new starts handling recruiting calls. Adding them doesn't send them interested agents: to add them to the contacts who receive those, chat with support and ask for a person." },
      { ol: [
        "Go to **Team** in the left menu.",
        "Click **Add member**.",
        "Enter their full name, title, email and phone.",
        "Click **Add member**.",
      ] },
      { p: "They'll appear in your team list right away. You can also assign them agents in your Pipeline: tick the agents and click **Assign to...**." },
      { p: "**Removing someone.** When a teammate leaves, tick them in the Team list and click **Delete selected**. If they're also one of the contacts who receive interested agents, chat with support and ask for a person, so we can take them off." },
      { p: "**Many people at once.** Click **Import CSV** and upload a file with each person's name, title, email and phone." },
    ],
  },
  {
    slug: "who-receives-interested-agents",
    title: "Who receives interested agents",
    blocks: [
      { p: "Interested agents go to the contacts on your account, not to everyone on your team. When an agent replies interested, we email those contacts and add the agent to your Pipeline." },
      { ul: [
        "**To see who they are,** click **Chat with support** and ask the assistant who receives your interested agents. It gives you their names and emails.",
        "**To change them,** chat with support and ask for a person, and our team will update them for you.",
        "**If you cover several markets,** each contact can cover their own, so an agent goes to the contact for their market.",
      ] },
      { p: "**Getting them into Follow Up Boss too.** If your team works leads in Follow Up Boss, connect it under **Integrations**. Paste your Follow Up Boss API key (in Follow Up Boss, go to My Settings, then API) and click **Connect**. From then on, every new agent in your Pipeline also goes straight into Follow Up Boss." },
      { p: "**Making sure nobody misses one.** Tell us when a contact leaves or is away, so we can change who receives them. If several people receive them, use **Assign to...** in the Pipeline so it's clear who replies to each agent." },
    ],
  },
  {
    slug: "turning-a-teammate-on-or-off",
    title: "Turning a teammate on or off",
    blocks: [
      { p: "The **Active** switch on your Team page doesn't change who receives interested agents: those go to the contacts on your account (see Who receives interested agents). If text alerts are on for your account, the switch decides who gets them, without removing anyone from your team." },
      { ol: [
        "Go to **Team** in the left menu.",
        "Find the person in the list.",
        "Flip the switch in the **Active** column. On means they can get text alerts; off means they don't.",
      ] },
      { p: "The change takes effect for the next interested agent." },
      { h: "When to turn someone off" },
      { ul: [
        "They're on vacation or leave.",
        "They've moved to a role that doesn't take recruiting calls.",
      ] },
      { p: "**If they're one of your contacts,** chat with support and ask for a person too, so we can change who receives your interested agents while they're away." },
    ],
  },
];

/** An article by its address (the page's ?article=), if there is one. */
export function articleBySlug(slug: string | null | undefined): HelpArticle | null {
  return HELP_ARTICLES.find((a) => a.slug === slug) ?? null;
}

export function articleByTitle(title: string): HelpArticle | null {
  return HELP_ARTICLES.find((a) => a.title === title) ?? null;
}

/** An article's words, without the markup: what Search looks through. */
export function articleText(a: HelpArticle): string {
  const words = a.blocks.flatMap((b): string[] => {
    if ("p" in b) return [b.p];
    if ("h" in b) return [b.h];
    if ("ol" in b) return b.ol;
    if ("ul" in b) return b.ul;
    return [...b.table.head, ...b.table.rows.flat()];
  });
  return [a.title, ...words].join(" ").replace(/\*\*/g, "");
}
