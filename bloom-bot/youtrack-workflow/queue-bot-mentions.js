const entities = require('@jetbrains/youtrack-scripting-api/entities');

// The Bot account is shared: developers' own Claude Code sessions post as Bot too. So a comment
// written by Bot never starts a request, whatever it says; otherwise every agent comment that
// quotes "@Bot" would land on the Mac mini.
const BOT_LOGIN = 'Bot';
const ALLOWED_GROUP = 'Developers';
const MENTION = /(^|[^\w@])@bot\b/i;

exports.rule = entities.Issue.onChange({
  title: 'Queue @Bot mentions from Developers for the Bloom bot',
  guard: (ctx) => ctx.issue.comments.added.isNotEmpty(),
  action: (ctx) => {
    const issue = ctx.issue;
    issue.comments.added.forEach((comment) => {
      if (comment.author.login === BOT_LOGIN) return;
      if (!MENTION.test(comment.text || '')) return;

      if (comment.author.isInGroup(ALLOWED_GROUP)) {
        // The bot on the Mac finds requests by searching for this text. The request is the
        // comment just before this one; the bot replaces this text with its answer, which
        // takes the issue out of that search. Limiting this comment to Developers keeps the
        // answer off the public tracker; the Bot account can't see groups, so it has to be
        // done here rather than by the bot.
        const queued = issue.addComment('[YouTrack workflow] Queued for the Bloom bot.', ctx.Bot);
        queued.permittedGroups.add(ctx.Developers);
      } else {
        issue.addComment(
          '[YouTrack workflow] @Bot only answers members of the Bloom developer team.',
          ctx.Bot
        );
      }
    });
  },
  requirements: {
    Bot: {
      type: entities.User,
      login: BOT_LOGIN
    },
    Developers: {
      type: entities.UserGroup,
      name: ALLOWED_GROUP
    }
  }
});
