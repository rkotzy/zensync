<a href="https://slacktozendesk.com">
  <img alt="Two-way sync between Slack threads and Zendesk tickets." src="https://github.com/rkotzy/zensync/blob/main/social-card.png?raw=true">
</a>

<h3 align="center">Zensync</h3>

<p align="center">
    Use Zendesk to support your customer Slack channels.
    <br />
    <a href="https://slacktozendesk.com"><strong>Learn more »</strong></a>
    <br />
    <br />
    <a href="#introduction"><strong>Introduction</strong></a> ·
    <a href="#get-started-for-free"><strong>Get Started</strong></a> ·
    <a href="#features"><strong>Features</strong></a> ·
    <a href="#tech-stack"><strong>Tech Stack</strong></a> ·
    <a href="#self-hosting"><strong>Self-hosting</strong></a>
</p>

<p align="center">
  <a href="https://github.com/rkotzy/zensync/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/rkotzy/zensync?label=license&logo=github&color=f80&logoColor=fff" alt="License" />
  </a>
</p>

<br/>

## Introduction

Zensync is a Slack bot that syncs threads from Slack with Zendesk tickets.

## Get started for free
### Slack App Directory (Recommended)
The fastest and most reliable way to get started is by installing Zensync from the [Slack App Directory](https://slacktozendesk.slack.com/apps/A06BB7W81NY-zensync?tab=more_info). You'll get all of the functionality in your first connected channel for free.

### Self-hosting
You can self-host Zensync for greater control over your data and app functionality. [Read this guide](https://slacktozendesk.com/docs/open-source/self-hosting) to learn more.

## Features

- [Zendesk assignee per channel](https://slacktozendesk.com/docs/getting-started/channel-settings)
- [Attachments](https://slacktozendesk.com/docs/messaging/files)
- [Threading multiple messages Slack messages into a single ticket](https://slacktozendesk.com/docs/messaging/creating#same-sender-message-threading)
- [Stripping Zendesk signatures](https://slacktozendesk.com/docs/messaging/signatures)
- [Minimum permissions](https://slacktozendesk.com/docs/platform/security)

## Tech Stack

- [TypeScript](https://www.typescriptlang.org/) – language
- [Slack Block Kit](https://api.slack.com/block-kit) – ui
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) – api
- [Cloudflare Queues](https://developers.cloudflare.com/queues/) – event processing
- [Cloudflare D1](https://developers.cloudflare.com/d1/) – database
- [Drizzle](https://orm.drizzle.team/) - orm
- [Posthog](https://posthog.com/) – product analytics
- [Stripe](https://stripe.com/) – payments

## License

Zensync is open-source under the GNU Affero General Public License Version 3 (AGPLv3) or any later version. You can [find it here](https://github.com/rkotzy/zensync/blob/main/LICENSE).
