const Story = require('../routes/story');
const User = require('../routes/users');
const Post = require('../routes/posts');
const upload = require('../routes/multer');

async function removeExpiredStories(now = Date.now()) {
  const expired = await Story.find({ date: { $lte: new Date(now - Story.lifetime) } })
    .sort({ date: 1 }).limit(100).select('_id story').lean();
  if (!expired.length) return 0;
  const ids = expired.map(story => story._id);
  await User.updateMany({ stories: { $in: ids } }, { $pull: { stories: { $in: ids } } });
  // Remove files before documents so failed file cleanup can be retried next time.
  for (const story of expired) {
    const shared = await Promise.all([
      Story.exists({ story: story.story, _id: { $nin: ids } }),
      Post.exists({ picture: story.story }),
      User.exists({ picture: story.story })
    ]);
    if (!shared.some(Boolean)) await upload.removeUploadedImage(story.story);
  }
  await Story.deleteMany({ _id: { $in: ids } });
  return expired.length;
}

function startStoryExpiration() {
  let running = false;
  async function sweep() {
    if (running || Story.db.readyState !== 1) return;
    running = true;
    try { await removeExpiredStories(); }
    catch (err) { console.error('Could not remove expired stories:', err.message); }
    finally { running = false; }
  }
  const timer = setInterval(sweep, 60000);
  timer.unref();
  sweep();
}

module.exports = { removeExpiredStories, startStoryExpiration };
