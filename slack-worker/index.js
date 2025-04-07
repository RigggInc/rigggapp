export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 📢 /slack-post — Send message to Slack
    if (pathname === "/slack-post" && request.method === "POST") {
      try {
        const body = await request.json();
        const { channel, text } = body;

        if (!channel || !text) {
          return new Response("Missing 'channel' or 'text'", { status: 400 });
        }

        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ channel, text })
        });

        const result = await res.json();
        return new Response(JSON.stringify(result), {
          status: res.ok ? 200 : 500,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        console.error("💥 Slack post failed:", err.stack || err);
        return new Response("Slack post error", { status: 500 });
      }
    }

    // 🧙‍♂️ / — Unified Slack handler: slash + app_mention
    if (pathname === "/" && request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";

      try {
        // 🔹 Slash Command (form-encoded)
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const formData = await request.text();

          ctx.waitUntil(
            fetch(env.ZAPIER_WEBHOOK_URL, { // Use the secret here
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: formData
            })
          );

          return new Response(JSON.stringify({
            response_type: "ephemeral",
            text: "✅ Task received! The Riggg Gnomes are on it. 🧙‍♂️⏳"
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        // 🔹 App Mention (JSON)
        if (contentType.includes("application/json")) {
          const payload = await request.json();

          // Slack's URL verification during event subscription
          if (payload.type === "url_verification") {
            return new Response(payload.challenge, {
              status: 200,
              headers: { "Content-Type": "text/plain" }
            });
          }

          if (payload.event?.type === "app_mention") {
            const text = payload.event.text.replace(/<@[^>]+>\s*/, "").trim();
            const user = payload.event.user;
            const channel = payload.event.channel;

            const formatted = `text=${encodeURIComponent(text)}&user_id=${user}&channel_id=${channel}`;

            // Fire to Zapier
            ctx.waitUntil(
              fetch(env.ZAPIER_WEBHOOK_URL, { // Use the secret here
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: formatted
              })
            );

            // Public reply in the channel
            ctx.waitUntil(
              fetch(`${url.origin}/slack-post`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`
                },
                body: JSON.stringify({
                  channel,
                  text: `✅ Got it! The Riggg Gnomes have logged your task: *${text}* 🧙‍♂️📋`
                })
              })
            );

            // Ephemeral reply to the user
            ctx.waitUntil(
              fetch("https://slack.com/api/chat.postEphemeral", {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  channel,
                  user,
                  text: `✅ Your request was received! The Riggg Gnomes are already sharpening their pencils 🧙‍♂️✏️`
                })
              })
            );

            return new Response("", { status: 200 });
          }
        }

        return new Response("Bad Request", { status: 400 });

      } catch (err) {
        console.error("💥 Unified handler failed:", err.stack || err);
        return new Response("Handler crashed", { status: 500 });
      }
    }

    // 🚫 Catch all
    return new Response("Not Found", { status: 404 });
  }
};
