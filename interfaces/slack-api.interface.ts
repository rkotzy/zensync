export interface SlackTeamResponse {
  ok: boolean;
  team: SlackTeam | undefined;
}

export interface SlackTeam {
  id: string;
  name: string;
  domain: string;
  email_domain: string;
  icon: SlackTeamIcon;
  enterprise_id: string | undefined;
  enterprise_name: string | undefined;
}

export interface SlackTeamIcon {
  image: string; // Representing the image_132 URL
}
