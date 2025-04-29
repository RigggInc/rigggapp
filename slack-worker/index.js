export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 📢 /slack-post — Send interactive message to Slack
    if (pathname === "/slack-post" && request.method === "POST") {
      // 🔐 Auth check ONLY for /slack-post
      const authHeader = request.headers.get("x-worker-auth");
      if (authHeader !== env.WORKER_AUTH_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const body = await request.json();
        const { channel, text, blocks, username = "Riggg Gnomes", emoji = ":gnome:" } = body;

        if (!channel || (!text && !blocks)) {
          return new Response("Missing required fields: 'channel' and either 'text' or 'blocks'", { status: 400 });
        }

        const slackPayload = {
          channel,
          text: text || " ",
          username,
          icon_emoji: emoji,
          ...(blocks && { blocks })
        };

        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(slackPayload)
        });

        const result = await res.json();
        console.log("📡 Slack API response:", result);

        return new Response(JSON.stringify(result), {
          status: res.ok ? 200 : 500,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        console.error("💥 Slack post failed:", err.stack || err);
        return new Response("Slack post error", { status: 500 });
      }
    }

    // 🎯 /slack-interaction — Handle buttons and modals
    if (pathname === "/slack-interaction" && request.method === "POST") {
      try {
        const form = await request.text();
        const params = new URLSearchParams(form);
        const payload = JSON.parse(params.get("payload"));

        const action = payload.actions?.[0];

        // 🔘 Handle stage buttons (Complete / Revisions Requested)
        if (action?.action_id === "set_stage_complete" || action?.action_id === "set_stage_revisions") {
          const { recordId, stage } = JSON.parse(action.value);

          // Update session_Stage
          await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_NAME}/${recordId}`, {
            method: "PATCH",
            headers: {
              "Authorization": `Bearer ${env.AIRTABLE_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              fields: { session_Stage: stage }
            })
          });

          // 🔁 If Revisions Requested → open modal
          if (action.action_id === "set_stage_revisions") {
            const triggerId = payload.trigger_id;

            await fetch("https://slack.com/api/views.open", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                trigger_id: triggerId,
                view: {
                  type: "modal",
                  callback_id: "revision_modal_submit",
                  private_metadata: JSON.stringify({
                    recordId,
                    channel: payload.channel.id,
                    thread_ts: payload.message.ts
                  }),
                  title: { type: "plain_text", text: "Revision Request" },
                  submit: { type: "plain_text", text: "Submit" },
                  close: { type: "plain_text", text: "Cancel" },
                  blocks: [
                    {
                      type: "input",
                      block_id: "revision_block",
                      label: { type: "plain_text", text: "What needs to be changed?" },
                      element: {
                        type: "plain_text_input",
                        action_id: "revision_input",
                        multiline: true
                      }
                    }
                  ]
                }
              })
            });

            return new Response("", { status: 200 });
          }

          // ✅ Otherwise, update Slack message
          const slackResponseText = `✅ Session marked as *${stage}* by <@${payload.user.id}>`;

          await fetch("https://slack.com/api/chat.update", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              channel: payload.channel.id,
              ts: payload.message.ts,
              text: slackResponseText,
              blocks: []
            })
          });

          return new Response("", { status: 200 });
        }

        // 📝 Modal Submission: Log to Airtable
        if (payload.type === "view_submission" && payload.view.callback_id === "revision_modal_submit") {
          const metadata = JSON.parse(payload.view.private_metadata);
          const revisionText = payload.view.state.values.revision_block.revision_input.value;

          // ✅ Create new Log record in Airtable
          await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Log`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.AIRTABLE_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              fields: {
                log_Notes: revisionText,
                log_EntryType: "Revision Request",
                log_SessionID: [metadata.recordId]
              }
            })
          });

          // 💬 Optional: Slack thread confirmation
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              channel: metadata.channel,
              thread_ts: metadata.thread_ts,
              text: "✅ Revision request logged to Airtable. The Gnomes are on it! 🧙‍♂️📋"
            })
          });

          return new Response("", { status: 200 });
        }

        return new Response("Unrecognized interaction", { status: 400 });

      } catch (err) {
        console.error("💥 Slack interaction error:", err.stack || err);
        return new Response("Interaction error", { status: 500 });
      }
    }

    // 🧙‍♂️ / — Slash commands & mentions (unchanged)
    if (pathname === "/" && request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";

      try {
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const formData = await request.text();
          ctx.waitUntil(fetch(env.ZAPIER_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formData
          }));

          return new Response(JSON.stringify({
            response_type: "in_channel",
            text: "✅ Task received! The Riggg Gnomes are on it. 🧙‍♂️⏳"
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (contentType.includes("application/json")) {
          const payload = await request.json();

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

            ctx.waitUntil(fetch(env.ZAPIER_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: formatted
            }));

            ctx.waitUntil(fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                channel,
                text: `✅ Got it! The Riggg Gnomes have logged your task: *${text}* 🧙‍♂️📋`
              })
            }));

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
