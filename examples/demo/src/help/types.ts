export type HelpEntry = {
  id: string;
  name: string;
  category: string;
  summary: string;
  details: string[];
  example: string;
  aliases?: string[];
};

export type ApiEntry = HelpEntry & {
  scope: "Global" | "Member" | "Callback parameter" | "Ambient binding";
  probe?: string;
};

export type SugarEntry = HelpEntry & {
  before: string;
  after: string[];
  reference: string;
};

export type HelpSignature = { label: string; source: string };
export type HelpSignatures = Record<string, HelpSignature[]>;
