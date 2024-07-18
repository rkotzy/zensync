export function responseHtml(teamId: string, appId: string): string {
    const html = `<!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width"/>
        <meta charset="utf-8"/>
        <title data-react-helmet="true"></title>
        <style>
            .button-text { margin-bottom: 6px; font-size: 14px; }
            .icon { margin-right: 6px; }
            .logo-container { width: 240px; margin-right: 0.5rem; }
            .logo-container > svg { fill: #f37f20; }
            .main-text { font-size: 15px; line-height: 1.5rem; }
            .content-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background-color: #f0f0f2; margin: 0; padding: 0 1rem; font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; }
            .card { max-width: 600px; margin: 5rem auto; padding: 2rem; background-color: #fdfdff; border-radius: 6px; box-shadow: 2px 3px 7px 2px rgba(0, 0, 0, 0.02); color: #333; }
        </style>
    </head>
    <body>
    <div id="__flareact">
        <div class="content-container">
            <div class="card">
                <div class="logo-container">
                    <!-- SVG Logo goes here -->
                </div>
                <h2 class="title">You have successfully authorized Zensync 🎉</h2>
                <p class="main-text">You're one step closer to taming your Slack support! Use the links below to dive right in our check out our getting started guides.</p>
                <div class="links-container">
                    <div class="link-item">
                    <span class="icon">🖥️</span>
                        <a href="slack://app?team=${teamId}&id=${appId}&tab=home" target="_blank" rel="noreferrer noopener">Open in Slack</a>
                    </div>
                    <div class="link-item">
                        <span class="icon">📖</span>
                        <a href="https://slacktozendesk.com/docs" target="_blank" rel="noreferrer noopener">Check out the docs and setup guides</a>
                    </div>
                </div>
                <h4 class="closing-remark">Feel free to close this browser window.</h4>
            </div>
        </div>
    </div>
    <!-- Scripts -->
    </body>
    </html>`;
    return html;
  }