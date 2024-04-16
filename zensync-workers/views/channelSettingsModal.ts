import { safeLog } from '@/lib/logging';
import { SlackConnection } from '@/lib/schema-sqlite';
import {
  GlobalSettingDefaults,
  GlobalSettings
} from '@/interfaces/global-settings.interface';
import { openSlackModal } from '@/lib/slack-api';
import { InteractivityActionId } from '@/lib/utils';

export async function openChannelSettings(
  payload: any,
  connection: SlackConnection
) {
  const triggerId = payload.trigger_id;

  if (!triggerId) {
    safeLog('warn', 'No trigger_id found in payload');
    return;
  }

  try {
    const globalSettings = connection.globalSettings as GlobalSettings;
    if (!globalSettings) {
      safeLog(
        'error',
        `No global settings found in connection ${connection.id}`
      );
      throw new Error('No global settings found in connection');
    }

    const selectionOptions = [
      {
        text: {
          type: 'plain_text',
          text: 'Off'
        },
        value: '0'
      },
      {
        text: {
          type: 'plain_text',
          text: '30 seconds'
        },
        value: '30'
      },
      {
        text: {
          type: 'plain_text',
          text: '1 minute'
        },
        value: '60'
      },
      {
        text: {
          type: 'plain_text',
          text: '5 minutes'
        },
        value: '300'
      },
      {
        text: {
          type: 'plain_text',
          text: '10 minutes'
        },
        value: '600'
      },
      {
        text: {
          type: 'plain_text',
          text: '30 minutes'
        },
        value: '1800'
      },
      {
        text: {
          type: 'plain_text',
          text: '1 hour'
        },
        value: '3600'
      },
      {
        text: {
          type: 'plain_text',
          text: '3 hours'
        },
        value: '10800'
      },
      {
        text: {
          type: 'plain_text',
          text: '8 hours'
        },
        value: '28800'
      },
      {
        text: {
          type: 'plain_text',
          text: '24 hours'
        },
        value: '86400'
      },
      {
        text: {
          type: 'plain_text',
          text: 'Uncapped'
        },
        value: '10000000'
      }
    ];

    const optionValueInSettings =
      globalSettings.sameSenderTimeframe ||
      GlobalSettingDefaults.sameSenderTimeframe;
    const index = selectionOptions.findIndex(
      option => option.value === optionValueInSettings.toString()
    );

    const selectedOption = index > -1 ? selectionOptions[index] : null;

    const body = JSON.stringify({
      trigger_id: triggerId,
      view: {
        notify_on_close: true,
        type: 'modal',
        callback_id: InteractivityActionId.CHANNEL_SETTINGS_MODAL_ID,
        title: {
          type: 'plain_text',
          text: 'Channel Settings',
          emoji: true
        },
        submit: {
          type: 'plain_text',
          text: `Save`,
          emoji: true
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true
        },
        blocks: [
          {
            type: 'input',
            block_id: 'channel_owner',
            optional: true,
            element: {
              type: 'email_text_input',
              action_id: InteractivityActionId.EDIT_CHANNEL_OWNER_FIELD,
              ...(globalSettings.defaultZendeskAssignee
                ? { initial_value: globalSettings.defaultZendeskAssignee }
                : {}),
              placeholder: {
                type: 'plain_text',
                text: 'Enter an email or leave blank'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Default Zendesk Assignee Email',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'The email address of the Zendesk agent who should be assigned new tickets. Can be overridden on a per-channel basis.'
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
                globalSettings.defaultZendeskTags
                  ? globalSettings.defaultZendeskTags.join(', ')
                  : ''
              }`,
              placeholder: {
                type: 'plain_text',
                text: 'example1, example2'
              }
            },
            label: {
              type: 'plain_text',
              text: 'Default Zendesk Tags',
              emoji: true
            },
            hint: {
              type: 'plain_text',
              text: 'Enter a comma separated list of tags to set on Zendesk tickets. Tags cannot contain spaces, dashes or special characters (-, #, @, !, etc.). Underscores "_" are allowed. Can be overriden on a per-channel basis. The tag `zensync` is always automatically applied.'
            }
          },
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: 'Same Sender Message Threading',
              emoji: true
            }
          },
          {
            type: 'section',
            block_id: 'same_sender_in_timeframe',
            text: {
              type: 'mrkdwn',
              text: 'Thead messages from the same sender into same Zendesk ticket within a timeframe:'
            },
            accessory: {
              type: 'static_select',
              action_id: InteractivityActionId.SAME_SENDER_IN_TIMEFRAME_FIELD,
              options: selectionOptions,
              initial_option: selectedOption
            }
          }
        ]
      }
    });

    await openSlackModal(body, connection);
  } catch (error) {
    safeLog('error', `Error in openChannelSettings: ${error}`);
    throw error;
  }
}
