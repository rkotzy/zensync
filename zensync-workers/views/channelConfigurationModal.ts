import { InteractivityActionId } from '@/lib/utils';
import { SlackConnection } from '@/lib/schema-sqlite';
import * as schema from '@/lib/schema-sqlite';
import { DrizzleD1Database } from 'drizzle-orm/d1';
import { safeLog } from '@/lib/logging';
import { getChannel } from '@/lib/database';
import { openSlackModal } from '@/lib/slack-api';
import { GlobalSettings } from '@/interfaces/global-settings.interface';

export async function openChannelConfigurationModal(
  actionId: string,
  payload: any,
  connection: SlackConnection,
  db: DrizzleD1Database<typeof schema>
) {
  const triggerId = payload.trigger_id;
  if (!triggerId) {
    safeLog('warn', 'No trigger_id found in payload');
    throw new Error('No trigger_id found in payload');
  }

  try {
    // Parse out the channel ID from the payload
    const channelId = actionId.split(':')[1];
    if (!channelId) {
      safeLog('error', 'No channel ID found in action ID');
      throw new Error('No channel ID found in action ID');
    }

    // Fetch channel info from the database
    const channelInfo = await getChannel(db, connection.id, channelId);

    if (!channelInfo) {
      safeLog('error', `No channel found for ID: ${channelId}`);
      throw new Error(`No channel found for ID: ${channelId}`);
    }

    const activityDate = channelInfo.latestActivityAtMs;

    const createdAtTimestamp = Math.floor(channelInfo.createdAtMs / 1000);
    const fallbackText = 'No message activity';

    // Initialize lastActivityString with the fallback text
    let lastActivityString = 'No message activity';

    // Only process latestActivityAt if it is not null
    if (activityDate) {
      const latestActivityTimestamp = Math.floor(activityDate / 1000);
      lastActivityString = `Last message on <!date^${latestActivityTimestamp}^{date_short} at {time}|${fallbackText}>`;
    }

    const createdAtString = `Created on <!date^${createdAtTimestamp}^{date_short} at {time}|Created at date unavailable>`;

    const globalSettings = connection.globalSettings as GlobalSettings;

    const body = JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: `${InteractivityActionId.EDIT_CHANNEL_CONFIGURATION_MODAL_ID}:${channelId}`,
        title: {
          type: 'plain_text',
          text: `#${channelInfo.name}`,
          emoji: true
        },
        submit: {
          type: 'plain_text',
          text: 'Save',
          emoji: true
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true
        },
        blocks: [
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${createdAtString}\n${lastActivityString}`
              }
            ]
          },
          {
            type: 'input',
            block_id: 'channel_owner',
            optional: true,
            element: {
              type: 'email_text_input',
              action_id: InteractivityActionId.EDIT_CHANNEL_OWNER_FIELD,
              ...(channelInfo.defaultAssigneeEmail
                ? { initial_value: channelInfo.defaultAssigneeEmail }
                : {}),
              placeholder: {
                type: 'plain_text',
                text: globalSettings.defaultZendeskAssignee
                  ? `${globalSettings.defaultZendeskAssignee} (global default)`
                  : 'Enter an email or leave blank'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk Assignee Email',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'The email address of the Zendesk agent who should be assigned new tickets from this channel. Leave blank to use global setting.'
            }
          },
          {
            type: 'input',
            block_id: 'channel_tags',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: InteractivityActionId.EDIT_CHANNEL_TAGS_FIELD,
              initial_value: `${
                channelInfo.tags ? channelInfo.tags.join(', ') : ''
              }`,
              placeholder: {
                type: 'plain_text',
                text:
                  globalSettings.defaultZendeskTags &&
                  globalSettings.defaultZendeskTags.length > 0
                    ? `${globalSettings.defaultZendeskTags.join(
                        ', '
                      )} (global default)`
                    : 'example1, example2'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Zendesk Tags',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'Enter a comma separated list of tags to set on Zendesk tickets created from this channel. Tags cannot contain spaces, dashes or special characters (-, #, @, !, etc.). Underscores "_" are allowed. The tag `zensync` is always automatically applied.'
            }
          }
        ]
      }
    });

    await openSlackModal(body, connection);
  } catch (error) {
    safeLog('error', `Error in openChannelConfigurationModal:`, error);
    throw error;
  }
}
