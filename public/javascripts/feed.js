(function () {
  const posts = document.querySelector('.posts.parent');
  const errorMessage = document.querySelector('#feederror');

  async function update(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (response.status === 401) {
      window.location.assign('/login');
      return null;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Could not update this post');
    return result;
  }

  posts.addEventListener('click', async function (event) {
    const like = event.target.closest('.likebutton, .postimg');
    const save = event.target.closest('.savebutton');
    if (!like && !save) return;
    const post = event.target.closest('.post');
    if (!post || !posts.contains(post)) return;
    const pendingKey = like ? 'likePending' : 'savePending';
    if (post.dataset[pendingKey]) return;
    post.dataset[pendingKey] = 'true';
    errorMessage.hidden = true;
    try {
      const result = await update('/' + (like ? 'like/' : 'save/') + encodeURIComponent(post.dataset.postid));
      if (!result) return;
      if (like) {
        const liked = result.like.includes(posts.dataset.userid);
        const icon = post.querySelector('.heart');
        icon.classList.toggle('ri-heart-3-line', !liked);
        icon.classList.toggle('ri-heart-3-fill', liked);
        icon.classList.toggle('text-red-500', liked);
        const button = post.querySelector('.likebutton');
        button.setAttribute('aria-pressed', String(liked));
        button.setAttribute('aria-label', liked ? 'Unlike post' : 'Like post');
        post.querySelector('.likeval').textContent = result.like.length + ' likes';
      } else {
        const saved = result.saved.includes(post.dataset.postid);
        const icon = post.querySelector('.save');
        icon.classList.toggle('ri-bookmark-line', !saved);
        icon.classList.toggle('ri-bookmark-fill', saved);
        icon.classList.toggle('text-zinc-100', saved);
        save.setAttribute('aria-pressed', String(saved));
        save.setAttribute('aria-label', saved ? 'Unsave post' : 'Save post');
      }
    } catch (error) {
      errorMessage.textContent = error.message || 'Could not connect. Please try again';
      errorMessage.hidden = false;
    } finally {
      delete post.dataset[pendingKey];
    }
  });
})();
