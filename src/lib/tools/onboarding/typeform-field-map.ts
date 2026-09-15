/*
 * Typeform form vnvitFKJ field refs -> client record.
 *
 * The tool's `config/field-map.json`, verified against the live form
 * 2026-07-02. Refs survive question rewording in Typeform; the title regexes
 * in typeform.ts stay as a fallback if a question is ever recreated.
 */
export const TYPEFORM_FIELD_MAP = {
  "client.client_name": "2fe1bb3f-1ef2-4dd1-9b24-0c8504685d07",
  "client.primary_contact.name": "d16c7455-2979-4cde-9f38-097799928e7e",
  "client.primary_contact.email": "1d365278-0af6-4f55-9e67-1d0a53da3dcc",
  "client.primary_contact.role": "1ca8ff22-3f74-4a83-a92a-30883776e898",
  "client.mls": "35acd6e4-aa9e-4784-98ea-a614b722de11",
  "client.location": "e0235340-d9c7-4496-b504-7b2bc371464e",
  _sales_volume_choice: "e93a28f3-6038-4d2b-8c5d-ea72e57eaf40",
  _talent_platforms: "26294e0c-75fb-4b8b-9eb9-0a4b6e91ed52",
  _dnc_exclude_list: "3e3c4066-77c5-4844-8a10-20b5f183fc72",
  "_team.intro_contacts": [
    "927de904-7e26-4651-aac7-ac0bdbbb9a5a",
    "4698d7cf-af86-4438-bfdc-239c06b7ea20",
    "9828a326-a586-4164-9856-a676595bd85c",
  ],
  "_team.intro_titles": [
    "e23724bf-8950-41fb-9aba-86308c031f3f",
    "a47d77d1-0bc5-423f-bd41-ee7899047110",
    "881dd38e-c048-43d0-b181-8751b16e86ef",
  ],
  "_team.office_contacts": ["e34d0add-0bac-4189-ac7e-af8f5e0d11a3"],
  _zillow_flex: "e213f104-e454-41aa-9d14-bdae010edf05",
  _copy_approval: "58664795-f977-45d6-8b3c-b30585c02c5e",
  _referral: "49aa28a4-5f60-4d27-ade2-815abc330f0a",
  _notes: "fb0308e4-bc91-4389-997b-0d919f57c5e2",
} as const;
