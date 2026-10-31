import { Clock3, Eye, HardDrive, KeyRound, Network, Server, UserMinus, Users } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsGroup, SettingsRow, SettingsSection } from "./rows";

type Point = { icon: ReactNode; title: string; body: string };

// Plain-language version of docs/architecture.md section 10. Keep the two in step.
const POINTS: readonly Point[] = [
  {
    icon: <Server />,
    title: "Your VM is yours",
    body: "Each environment is a separate cloud VM under your name. Only you can open its terminal. Teammates see its status, never its shell.",
  },
  {
    icon: <HardDrive />,
    title: "Your logins stay in your Linux home",
    body: "Your coding CLI sign-ins live in your home folder on your VM. We never read those files; health checks only ask the CLI whether it is signed in, or check that its sign-in file exists.",
  },
  {
    icon: <Users />,
    title: "Teammates trust each other's agents",
    body: "Every agent in a team joins one Agent Relay workspace and runs without permission prompts. Teams are walled off from each other, but inside a team, any agent can message any other. Only invite people whose agents you'd let near your code.",
  },
  {
    icon: <Eye />,
    title: "Agent chat is visible to the team",
    body: "Every member can read the messages humans send to agents in this team, including direct messages.",
  },
  {
    icon: <UserMinus />,
    title: "Removing someone cuts them off",
    body: "Removing a member cuts their access right away: their sessions and terminals close, and their machines in this team are deleted. Work they had not pushed yet is lost.",
  },
  {
    icon: <KeyRound />,
    title: "Vendor keys never reach your browser",
    body: "Keys for GitHub, Freestyle and Agent Relay stay on our server, and secrets we store, like your GitHub token, are encrypted. Your browser only holds a session cookie that page scripts can't read.",
  },
  {
    icon: <Clock3 />,
    title: "Terminal tokens are short-lived",
    body: "Opening your terminal mints a token that works for 15 minutes, on one VM, as one Linux user. It's kept in this tab's memory only, never stored or logged.",
  },
  {
    icon: <Network />,
    title: "Agent messages are treated as untrusted",
    body: "Text from agents is never run as a command or shown as HTML. A task only counts as done once its commits are on GitHub, merge cleanly and pass the tests.",
  },
];

export function SecuritySection() {
  return (
    <SettingsSection title="Security" description="What is isolated, what is shared, and what we can and can't see.">
      <SettingsGroup>
        {POINTS.map((point) => (
          <SettingsRow
            key={point.title}
            icon={<span className="grid size-8 place-items-center rounded-control-compact bg-fill text-muted [&_svg]:size-4">{point.icon}</span>}
            title={point.title}
            description={point.body}
            className="sm:items-start [&>div]:sm:items-start"
          />
        ))}
      </SettingsGroup>
      <p className="mt-2 px-1 text-[12.5px] leading-[1.5] text-muted text-pretty">
        Two honest limits. Our Freestyle account has root on the VMs it runs. Policy forbids reading your files and no code path does,
        but it is a trust boundary you should know about. And the team&rsquo;s Relay workspace key cannot be rotated. If a removed member
        could have read it, create a new team to fully cut them off.
      </p>
    </SettingsSection>
  );
}
