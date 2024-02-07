export interface SlackResponse {
  ok: boolean;
  team?: SlackTeam;
  error?: string;
  user?: any;
  access_token?: string;
  authed_user?: any;
  bot_user_id?: string;
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
  image_132: string; // Representing the image_132 URL
}

export interface SlackMessageData {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

// TODO: - Add interfaces for files
