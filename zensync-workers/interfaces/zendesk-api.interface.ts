export interface ZendeskEvent {
  ticket_id?: any;
  external_id?: any;
  last_updated_at?: any;
  created_at?: any;
  requester_email?: any;
  requester_external_id?: any;
  current_user_email?: any;
  current_user_name?: any;
  current_user_external_id?: any;
  message?: any;
  is_public?: any;
  attachments?: any[];
  via?: any;
}

export interface ZendeskResponse {
  [key: string]: any;
}