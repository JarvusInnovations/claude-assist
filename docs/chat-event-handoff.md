# Chat event hand-off: Slack app setup

The chat module can pass Slack events that are not the owner's direct
messages (mentions, channel messages, reactions) to an external command,
one JSON object per event on stdin, with no agent run. Another consumer,
such as a long-running agent session's wake file, can then act on them
while the chat module keeps the app's only Socket Mode connection. The
behaviour is specified in `specs/modules/chat.md` § Event hand-off.

## Server configuration

```sh
CHAT_HANDOFF_COMMAND='["/path/to/consumer", "--from", "slack"]'  # JSON argv, no shell
CHAT_HANDOFF_EVENTS=app_mention,message,reaction_added           # default: all three
CHAT_HANDOFF_AUTHORS=owner                                       # owner (default) | any
CHAT_HANDOFF_TIMEOUT_MS=10000
```

## Slack app additions

The hand-off only receives events the Slack app subscribes to. Add these bot
events and the scopes they require, then reinstall the app to the workspace
so the bot token picks up the new scopes:

| Bot event | Scope |
| --- | --- |
| `app_mention` | `app_mentions:read` |
| `message.channels` | `channels:history` |
| `message.groups` | `groups:history` |
| `message.mpim` | `mpim:history` |
| `reaction_added` | `reactions:read` |

In an app manifest, these are additions to the existing `oauth_config` and
`settings.event_subscriptions` blocks, alongside what the chat module
already uses (such as `im:history` and `message.im`):

```yaml
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - mpim:history
      - reactions:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.mpim
      - reaction_added
```

Only subscribe to the events in `CHAT_HANDOFF_EVENTS`; an event the app
does not subscribe to never arrives. Channel and private-channel messages
arrive only from conversations the bot has been added to.
