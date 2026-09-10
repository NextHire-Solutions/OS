/*
 * The three sources' output columns — copied out of the tool, not retyped.
 *
 * These arrays were extracted by importing the tool's own modules and dumping
 * them, so they are exact:
 *
 *   courted/src/constants.js            OUTPUT_COLUMNS   77 columns
 *   src/constants.js                    OUTPUT_COLUMNS   45 columns
 *   web/server/engines/realtor-map.js   OUTPUT_COLUMNS   45 columns
 *
 * Order matters twice over. It is the CSV layout the client asked for, and it
 * is the order `merge.js` unions the three sets in to build the master list's
 * columns — so a reordering here silently reorders every export.
 *
 * The live service also serves these at GET /api/columns. Holding them here as
 * well is not duplication for its own sake: the Search screen needs a table
 * header before any request completes, and rendering a fallback set that then
 * changes shape is worse than rendering the real one immediately. The proxied
 * endpoint still wins when it answers — see `useColumns` in the screen.
 */

export const COURTED_COLUMNS: readonly string[] = [
  "Name",
  "First Name",
  "Last Name",
  "Nickname",
  "Title",
  "Email",
  "Phone",
  "Mobile Phone",
  "Saved Contact Info",
  "Profile Photo URL",
  "Courted Profile URL",
  "Courted Agent ID",
  "Courted ID",
  "Member MLS ID",
  "Office",
  "Custom Office Name",
  "Brand",
  "Office Address",
  "Office City",
  "Office State",
  "Office Zip",
  "Time At Current Office (mos)",
  "Avg Time At Office (mos)",
  "Years Of Experience",
  "Agent Tenure (mos)",
  "Is New Agent",
  "LTM Sales Volume",
  "Prev LTM Sales Volume",
  "Sales Volume Change %",
  "LTM Est GCI",
  "LTM Avg Sale Price",
  "LTM Closed Transactions",
  "LTM Closed Units",
  "LTM Units Buy-Side",
  "LTM Units List-Side",
  "LTM Sales Volume Buy-Side",
  "LTM Sales Volume List-Side",
  "LTM Avg Sale Price Buy-Side",
  "LTM Avg Sale Price List-Side",
  "LTM Close-To-List Price %",
  "LTM Avg Days On Market",
  "LTM Rental Count",
  "LTM Avg Rental Price",
  "YTD Sales Volume",
  "YTD Units",
  "YTD Avg Sale Price",
  "Active Listings",
  "Pending Listings",
  "Sales Volume Prediction",
  "Prediction Low",
  "Prediction High",
  "Likelihood To Move",
  "Future Growth Tag",
  "Forecast Segment",
  "AI Agent Type",
  "Most Transacted City",
  "Most Transacted State",
  "Most Transacted Zip",
  "MLS",
  "MLS ID",
  "State License",
  "Alt State Licenses",
  "MLS Affiliations",
  "Is Team Leader",
  "Is Team Member",
  "Is Managing Broker",
  "Is Rental Agent",
  "Home Address",
  "Home City",
  "Home State",
  "Home Zip",
  "Prospect Status",
  "Assigned To",
  "Connections",
  "Is Watching",
  "Is Liked",
  "Searched Location",
];

export const ZILLOW_COLUMNS: readonly string[] = [
  "Name",
  "Brokerage",
  "Phone",
  "Email",
  "Rating",
  "Review Count",
  "Total Sales Count",
  "Active Listings Count",
  "For Sale Count",
  "For Rent Count",
  "Sold Count",
  "Specialties",
  "Service Areas",
  "Years of Experience",
  "Languages Spoken",
  "Location",
  "City",
  "State",
  "Zip Code",
  "Profile Photo URL",
  "Zillow Profile URL",
  "Top Agent on Zillow",
  "Is Team",
  "Team Name",
  "Team Member Count",
  "Average Sales Volume",
  "Average Price",
  "Sales Count Last Year",
  "Premier Agent",
  "Local Sales Count",
  "Legal Name",
  "Title",
  "Address",
  "Brokerage Address",
  "Website URL",
  "Facebook URL",
  "LinkedIn URL",
  "Instagram URL",
  "Twitter URL",
  "YouTube URL",
  "Pinterest URL",
  "License Number",
  "License State",
  "License Description",
  "All Licenses",
];

export const REALTOR_COLUMNS: readonly string[] = [
  "Name",
  "First Name",
  "Last Name",
  "Phone",
  "Mobile Phone",
  "Email",
  "Office",
  "Broker",
  "Office Address",
  "Office City",
  "Office State",
  "Office Postal",
  "Rating",
  "Review Count",
  "Recommendations",
  "Years Of Experience",
  "Experience Since",
  "Languages",
  "Specializations",
  "Designations",
  "Served Areas",
  "For Sale Count",
  "For Sale Price Range",
  "Sold Count",
  "Sold Price Range",
  "Last Sold Date",
  "Combined Price Range",
  "License Number",
  "License State",
  "MLS",
  "Website URL",
  "Facebook URL",
  "Instagram URL",
  "LinkedIn URL",
  "Twitter URL",
  "YouTube URL",
  "TikTok URL",
  "Profile Photo URL",
  "Bio",
  "Is Realtor",
  "Is Advertiser",
  "Realtor Profile URL",
  "Realtor Agent ID",
  "Fulfillment ID",
  "Searched Location",
];

/** The full set, keyed the way every route and screen refers to them. */
export const ALL_COLUMNS = {
  courted: COURTED_COLUMNS,
  zillow: ZILLOW_COLUMNS,
  realtor: REALTOR_COLUMNS,
} as const;

export type SourceId = keyof typeof ALL_COLUMNS;

/** Fixed order, everywhere. The tool iterates sources in exactly this order. */
export const SOURCES: readonly SourceId[] = ["courted", "zillow", "realtor"];

/*
 * The compact view. Copied verbatim from web/public/app.js `KEY_COLS` — the
 * "Show all columns" toggle switches between this and the full set above, and
 * the full set is the default.
 */
export const KEY_COLUMNS: Record<SourceId, readonly string[]> = {
  courted: [
    "Name", "Office", "Email", "Phone", "Years Of Experience",
    "LTM Sales Volume", "Sales Volume Change %", "LTM Closed Units",
    "Active Listings", "Most Transacted City", "MLS", "State License",
  ],
  zillow: [
    "Name", "Brokerage", "Phone", "Email", "Rating", "Review Count",
    "Total Sales Count", "Average Price", "For Sale Count", "Location",
    "Zillow Profile URL",
  ],
  realtor: [
    "Name", "Office", "Phone", "Mobile Phone", "Rating", "Review Count",
    "Years Of Experience", "For Sale Count", "Sold Count", "Combined Price Range",
    "License Number", "Served Areas", "Realtor Profile URL",
  ],
};

/** Columns rendered as a link rather than as text. Verbatim from app.js. */
export const URL_COLUMNS = new Set([
  "Zillow Profile URL", "Courted Profile URL", "Realtor Profile URL",
  "Profile Photo URL", "Website URL", "Facebook URL", "Instagram URL",
  "LinkedIn URL", "Twitter URL", "YouTube URL", "TikTok URL",
]);

/** Columns rendered as currency when the value is all digits. Verbatim. */
export const MONEY_COLUMNS = new Set([
  "LTM Sales Volume", "LTM Est GCI", "LTM Avg Sale Price", "YTD Sales Volume",
]);

/** The Import screen's own fixed columns. Verbatim from app.js `IMPORT_COLS`. */
export const IMPORT_COLUMNS: readonly string[] = [
  "Status", "Source", "Name", "Phone", "Email", "License", "Profile URL", "Note",
];
