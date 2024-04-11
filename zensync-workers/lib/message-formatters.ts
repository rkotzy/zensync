export function stripSignatureFromMessage(
  message: string | undefined | null,
  signature: string | undefined | null
): string {
  // Return the original message if it exists, otherwise return an empty string
  if (!message) {
    return '';
  }

  // If there's no signature, or the signature is not at the end, return the original message
  if (!signature || !message.endsWith(signature)) {
    return message;
  }

  // Remove the signature from the end of the message
  return message.slice(0, message.length - signature.length);
}

export function zendeskToSlackMarkdown(zendeskMessage: string): string {
  // Replace Zendesk bold (**text**) with Slack bold (*text*)
  let slackMessage = zendeskMessage.replace(/\*\*(.*?)\*\*/g, '*$1*');

  // Other transformations could be added here if necessary

  return slackMessage;
}
