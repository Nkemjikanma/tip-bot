import type { PlainMessage, SlashCommand } from "@towns-protocol/proto";

const commands = [
  {
    name: "help",
    description: "Get help with bot commands",
  },
  {
    name: "leaderboard",
    description: "See who's been keeping the channel on fire",
  },
] as const satisfies PlainMessage<SlashCommand>[];

export default commands;
