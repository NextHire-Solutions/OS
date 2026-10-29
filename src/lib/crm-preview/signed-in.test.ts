/* The name the new portal shows as "you" (signed-in.ts, 29 Oct). Run with node --import ./scripts/alias-hooks.mjs --test. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { personName, teamName } from "./signed-in.ts";

// BrokerStaffer's portal as it is: the record's contact is Ryan; Eddy, Amy and Ryan are its team and its sign-in list.
const TEAM = [
  { name: "Amy Anderes-Damron", email: "amy@brokerstaffer.com" },
  { name: "Eddy Boccara", email: "Eddy@BrokerStaffer.com " },
  { name: "Ryan Jagdeo", email: "ryan.j@brokerstaffer.com" },
];

test("Eddy signed in is shown as Eddy — never the record's contact (Ryan)", () => {
  assert.equal(personName("eddy@brokerstaffer.com", { team: teamName("eddy@brokerstaffer.com", TEAM), listed: "Eddy B" }), "Eddy Boccara");
});

test("the team's name first, then the sign-in list's, then the OS account's, then the address", () => {
  assert.equal(personName("x@client.test", { team: "On The Team", listed: "Listed", account: "Account" }), "On The Team");
  assert.equal(personName("x@client.test", { team: null, listed: "Listed", account: "Account" }), "Listed");
  assert.equal(personName("x@client.test", { team: null, listed: "  ", account: "Amy Anderes" }), "Amy Anderes");
  assert.equal(personName(" X@Client.test ", {}), "x@client.test");
});

test("the team match is by address — case and spaces aside; no address, no match", () => {
  assert.equal(teamName("EDDY@brokerstaffer.com", TEAM), "Eddy Boccara");
  assert.equal(teamName("someone@else.test", TEAM), null);
  assert.equal(teamName("", [{ name: "No Email", email: null }]), null);
});

import { firstName } from "./signed-in.ts";

test("greetings use a first name — never an address", () => {
  assert.equal(firstName("Eddy Boccara"), "Eddy");
  assert.equal(firstName("admin@outreachify.io"), "");
  assert.equal(firstName("  "), "");
  assert.equal(firstName(null), "");
});
