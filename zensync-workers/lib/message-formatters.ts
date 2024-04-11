import { SlackConnection } from "./schema-sqlite";
import { SlackMessageData } from "@/interfaces/slack-api.interface";

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

export function generateHTMLPermalink(
  slackConnection: SlackConnection,
  messageData: SlackMessageData
): string {
  return `<p><i>(<a href="https://${
    slackConnection.domain
  }.slack.com/archives/${messageData.channel}/p${messageData.ts.replace(
    '.',
    ''
  )}">View in Slack</a>)</i></p>`;
}

export function slackMarkdownToHtml(markdown: string): string {
  // Handle block quotes
  markdown = markdown.replace(/^>\s?(.*)/gm, '<blockquote>$1</blockquote>');

  // Handle code blocks first to prevent formatting inside them
  markdown = markdown.replace(
    /```(.*?)```/gs,
    (_, code) => `<pre><code>${escapeCurlyBraces(code)}</code></pre>`
  );

  // Handle ordered lists
  markdown = markdown.replace(
    /^\d+\.\s(.*)/gm,
    (_, item) => `<li>${item}</li>`
  );
  markdown = markdown.replace(/(<li>.*<\/li>)/gs, '<ol>$1</ol>');

  // Handle bulleted lists
  markdown = markdown.replace(
    /^[\*\+\-]\s(.*)/gm,
    (_, item) => `<li>${item}</li>`
  );
  markdown = markdown.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');

  // Handle inline code
  markdown = markdown.replace(
    /`(.*?)`/g,
    (_, code) => `<code>${escapeCurlyBraces(code)}</code>`
  );

  // Convert bold text: *text*
  markdown = markdown.replace(/\*(.*?)\*/g, '<strong>$1</strong>');

  // Convert italic text: _text_
  markdown = markdown.replace(/_(.*?)_/g, '<em>$1</em>');

  // Convert strikethrough: ~text~
  markdown = markdown.replace(/~(.*?)~/g, '<del>$1</del>');

  // Convert new lines to <br> for lines not inside block elements
  markdown = markdown.replace(
    /^(?!<li>|<\/li>|<ol>|<\/ol>|<ul>|<\/ul>|<pre>|<\/pre>|<blockquote>|<\/blockquote>).*$/gm,
    '$&<br>'
  );

  return markdown;
}

function escapeCurlyBraces(code: string): string {
  return code.replace(/{{(.*?)}}/g, '&lcub;&lcub;$1&rcub;&rcub;');
}
