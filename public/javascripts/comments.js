(function () {
  const posts = document.querySelector('.posts.parent');
  const states = new WeakMap();

  function stateFor(post) {
    if (!states.has(post)) states.set(post, { comments: null, loading: false, pending: false, parent: null });
    return states.get(post);
  }

  function endpoint(post) {
    return '/posts/' + encodeURIComponent(post.dataset.postid) + '/comments';
  }

  async function request(url, options) {
    const response = await fetch(url, { ...options, headers: { Accept: 'application/json', ...options?.headers } });
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('Please log in to continue');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Could not load comments');
    return result;
  }

  function setBusy(post) {
    const state = stateFor(post);
    const busy = state.loading || state.pending || state.comments === null;
    post.querySelectorAll('.commentform textarea, .commentform button, .replybutton').forEach(control => {
      control.disabled = busy;
    });
    post.querySelector('.commentform').setAttribute('aria-busy', String(state.pending));
  }

  function setReply(post, comment) {
    const state = stateFor(post);
    state.parent = comment ? comment._id : null;
    post.querySelector('.reply-context').hidden = !comment;
    post.querySelector('.reply-label').textContent = comment
      ? 'Replying to ' + (comment.user ? '@' + comment.user.username : 'Deleted user') : '';
    post.querySelector('.commentform label').textContent = comment ? 'Add a reply' : 'Add a comment';
    post.querySelector('.commentform textarea').focus();
  }

  function render(post) {
    const state = stateFor(post);
    const list = post.querySelector('.comments-list');
    const fragment = document.createDocumentFragment();
    const threads = new Map();
    const replies = new Map();
    for (const comment of state.comments) {
      if (!comment.parent) continue;
      if (!replies.has(comment.parent)) replies.set(comment.parent, []);
      replies.get(comment.parent).push(comment);
    }
    function entry(comment) {
      const item = document.createElement('div');
      item.className = 'comment-entry mt-3';
      item.dataset.commentid = comment._id;
      const author = document.createElement(comment.user ? 'a' : 'span');
      author.className = 'font-semibold';
      author.textContent = comment.user ? comment.user.username : 'Deleted user';
      if (comment.user) author.href = '/profile/' + encodeURIComponent(comment.user.username);
      const text = document.createElement('p');
      text.className = 'whitespace-pre-wrap break-words';
      text.textContent = comment.text;
      const date = document.createElement('time');
      date.className = 'text-xs text-zinc-400';
      date.dateTime = comment.date;
      date.textContent = new Date(comment.date).toLocaleString();
      item.append(author, text, date);
      if (!comment.parent) {
        const reply = document.createElement('button');
        reply.type = 'button';
        reply.className = 'replybutton text-blue-500 ml-3';
        reply.textContent = 'Reply';
        reply.setAttribute('aria-label', 'Reply to ' + author.textContent);
        item.append(reply);
      }
      return item;
    }
    for (const comment of state.comments) {
      if (comment.parent) continue;
      const thread = entry(comment);
      const children = document.createElement('div');
      children.className = 'comment-replies ml-4 pl-3 border-l border-zinc-700';
      for (const reply of replies.get(comment._id) || []) children.append(entry(reply));
      thread.append(children);
      fragment.append(thread);
      threads.set(comment._id, thread);
    }
    // Keep replies readable even if their parent is no longer available.
    for (const comment of state.comments) {
      if (comment.parent && !threads.has(comment.parent)) fragment.append(entry(comment));
    }
    list.replaceChildren(fragment);
    post.querySelector('.commentcount').textContent = state.comments.length;
    post.querySelector('.comments-status').textContent = state.comments.length ? '' : 'No comments yet. Start the conversation.';
    setBusy(post);
  }

  async function load(post) {
    const state = stateFor(post);
    if (state.loading) return;
    state.loading = true;
    post.querySelector('.comments-status').textContent = 'Loading comments…';
    post.querySelector('.comments-retry').hidden = true;
    setBusy(post);
    try {
      const result = await request(endpoint(post));
      state.comments = result.comments;
      render(post);
    } catch (error) {
      post.querySelector('.comments-status').textContent = error.message || 'Could not connect. Please try again';
      post.querySelector('.comments-retry').hidden = false;
    } finally {
      state.loading = false;
      setBusy(post);
    }
  }

  posts.addEventListener('click', function (event) {
    const control = event.target.closest('.commenttoggle, .comments-retry, .replybutton, .cancelreply');
    if (!control || !posts.contains(control)) return;
    const post = control.closest('.post');
    const state = stateFor(post);
    if (control.classList.contains('commenttoggle')) {
      const panel = post.querySelector('.comments-panel');
      panel.hidden = !panel.hidden;
      post.querySelectorAll('.commenttoggle').forEach(button => {
        button.setAttribute('aria-expanded', String(!panel.hidden));
      });
      const iconButton = post.querySelector('.commenttoggle[aria-label]');
      iconButton.setAttribute('aria-label', panel.hidden ? 'Show comments' : 'Hide comments');
      if (!panel.hidden && state.comments === null) load(post);
    } else if (control.classList.contains('comments-retry')) {
      load(post);
    } else if (!state.pending && state.comments !== null) {
      const entry = control.closest('.comment-entry');
      setReply(post, entry ? state.comments.find(comment => comment._id === entry.dataset.commentid) : null);
    }
  });

  posts.addEventListener('submit', async function (event) {
    const form = event.target.closest('.commentform');
    if (!form) return;
    event.preventDefault();
    const post = form.closest('.post');
    const state = stateFor(post);
    if (state.pending || state.loading || state.comments === null) return;
    const input = form.querySelector('textarea');
    const errorMessage = form.querySelector('.comment-error');
    errorMessage.hidden = true;
    if (!input.value.trim()) {
      errorMessage.textContent = 'Write a comment before posting';
      errorMessage.hidden = false;
      input.focus();
      return;
    }
    state.pending = true;
    setBusy(post);
    try {
      const result = await request(endpoint(post), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input.value, parent: state.parent })
      });
      state.comments.push(result.comment);
      input.value = '';
      setReply(post, null);
      render(post);
    } catch (error) {
      errorMessage.textContent = error.message || 'Could not connect. Please try again';
      errorMessage.hidden = false;
    } finally {
      state.pending = false;
      setBusy(post);
      input.focus();
    }
  });
  posts.querySelectorAll('.post').forEach(post => {
    if (!post.querySelector('.comments-panel').hidden) load(post);
  });
})();
