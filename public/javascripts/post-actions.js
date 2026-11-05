(function () {
  const posts = document.querySelector('.posts.parent');

  function panels(post, editing, deleting) {
    post.querySelector('.editpostform').hidden = !editing;
    post.querySelector('.deletepostconfirm').hidden = !deleting;
    post.querySelector('.editpost').setAttribute('aria-expanded', String(editing));
    post.querySelector('.deletepost').setAttribute('aria-expanded', String(deleting));
    post.querySelector('.post-action-error').hidden = true;
  }

  async function mutate(post, method, values) {
    const response = await fetch('/posts/' + encodeURIComponent(post.dataset.postid), {
      method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(values ? { body: JSON.stringify(values) } : {})
    });
    if (response.status === 401) {
      window.location.assign('/login');
      return null;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Could not update this post');
    return result;
  }

  async function save(post, method, values) {
    if (post.dataset.actionPending) return;
    post.dataset.actionPending = 'true';
    const controls = post.querySelectorAll('.post-actions button, .editpostform button, .editpostform textarea, .deletepostconfirm button');
    controls.forEach(control => { control.disabled = true; });
    const errorMessage = post.querySelector('.post-action-error');
    errorMessage.hidden = true;
    let focusTarget;
    try {
      const result = await mutate(post, method, values);
      if (!result) return;
      if (method === 'PATCH') {
        post.querySelector('.post-caption').textContent = result.caption;
        panels(post, false, false);
        focusTarget = post.querySelector('.editpost');
      } else {
        const next = post.nextElementSibling || post.previousElementSibling;
        post.remove();
        if (!posts.querySelector('.post')) {
          const empty = document.createElement('div');
          empty.className = 'feedempty px-4 py-10 text-center';
          const text = document.createElement('p');
          text.textContent = 'No posts yet.';
          const link = document.createElement('a');
          link.href = '/upload';
          link.className = 'text-blue-500';
          link.textContent = 'Share your first photo';
          empty.append(text, link);
          posts.append(empty);
          link.focus();
        } else if (next) {
          next.querySelector('button')?.focus();
        }
      }
    } catch (error) {
      errorMessage.textContent = error.message || 'Could not connect. Please try again';
      errorMessage.hidden = false;
    } finally {
      delete post.dataset.actionPending;
      controls.forEach(control => { control.disabled = false; });
      if (focusTarget) focusTarget.focus();
    }
  }

  posts.addEventListener('click', function (event) {
    const button = event.target.closest('.editpost, .deletepost, .cancelpostedit, .cancelpostdelete, .confirmdeletepost');
    if (!button || !posts.contains(button)) return;
    const post = button.closest('.post');
    if (post.dataset.actionPending) return;
    if (button.classList.contains('editpost')) {
      const open = post.querySelector('.editpostform').hidden;
      panels(post, open, false);
      if (open) {
        const input = post.querySelector('.editpostform textarea');
        input.value = post.querySelector('.post-caption').textContent;
        input.focus();
      }
    } else if (button.classList.contains('deletepost')) {
      const open = post.querySelector('.deletepostconfirm').hidden;
      panels(post, false, open);
      if (open) post.querySelector('.cancelpostdelete').focus();
    } else if (button.classList.contains('confirmdeletepost')) {
      save(post, 'DELETE');
    } else {
      panels(post, false, false);
      post.querySelector(button.classList.contains('cancelpostedit') ? '.editpost' : '.deletepost').focus();
    }
  });

  posts.addEventListener('submit', function (event) {
    if (!event.target.matches('.editpostform')) return;
    event.preventDefault();
    save(event.target.closest('.post'), 'PATCH', { caption: event.target.elements.caption.value });
  });
})();
