// entrypoint: Cloudflare Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === "/slack-post" && request.method === "POST") {
        return await handleSlackPost(request, env);
      }

      if (pathname === "/slack-interaction" && request.method === "POST") {
        return await handleSlackInteraction(request, env);
      }

      if (pathname === "/" && request.method === "POST") {
        return await handleRootCommand(request, env, ctx);
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("💥 Global error handler:", err.stack || err);
      return new Response("Internal error", { status: 500 });
    }
  }
};

// ✅ /slack-post
async function handleSlackPost(request, env) {
  const authHeader = request.headers.get("x-worker-auth");
  if (authHeader !== env.WORKER_AUTH_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

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
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
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
}

// ✅ /slack-interaction
async function handleSlackInteraction(request, env) {
  const form = await request.text();
  const params = new URLSearchParams(form);
  const payload = JSON.parse(params.get("payload"));
  const action = payload.actions?.[0];

  switch (payload.type) {
    case "block_actions":
      if (action?.action_id === "set_stage_complete" || action?.action_id === "set_stage_revisions") {
        return await handleStageButtonAction(payload, action, env);
      }
      break;
    case "view_submission":
      if (payload.view.callback_id === "revision_modal_submit") {
        return await handleRevisionModalSubmit(payload, env);
      }
      break;
  }

  return new Response("Unrecognized interaction", { status: 400 });
}

async function handleStageButtonAction(payload, action, env) {
  const { recordId, stage } = JSON.parse(action.value);

  await updateAirtableRecord(env, env.AIRTABLE_TABLE_NAME, recordId, {
    session_Stage: stage
  });

  if (action.action_id === "set_stage_revisions") {
    return await openRevisionModal(payload, recordId, env);
  }

  const slackResponseText = `✅ Session marked as *${stage}* by <@${payload.user.id}>`;
  await updateSlackMessage(env, payload.channel.id, payload.message.ts, slackResponseText);

  return new Response("", { status: 200 });
}

async function openRevisionModal(payload, recordId, env) {
  const triggerId = payload.trigger_id;
  const view = {
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
  };

  await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ trigger_id: triggerId, view })
  });

  return new Response("", { status: 200 });
}

async function handleRevisionModalSubmit(payload, env) {
  const metadata = JSON.parse(payload.view.private_metadata);
  const revisionText = payload.view.state.values.revision_block.revision_input.value;

  await updateAirtableRecord(env, "Log", null, {
    log_Notes: revisionText,
    log_EntryType: "Revision Request",
    log_SessionID: [metadata.recordId]
  });

  await postToSlackThread(env, metadata.channel, metadata.thread_ts, "✅ Revision request logged to Airtable. The Gnomes are on it! 🧙‍♂️📋");
  return new Response("", { status: 200 });
}

async function updateAirtableRecord(env, table, recordId, fields) {
  const method = recordId ? "PATCH" : "POST";
  const endpoint = recordId
    ? `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${table}/${recordId}`
    : `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${table}`;

  await fetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields })
  });
}

async function updateSlackMessage(env, channel, ts, text) {
  await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ channel, ts, text, blocks: [] })
  });
}

async function postToSlackThread(env, channel, thread_ts, text) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ channel, thread_ts, text })
  });
}

// ✅ Slash command and app mention handler
async function handleRootCommand(request, env, ctx) {
  const contentType = request.headers.get("content-type") || "";

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
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
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
}
