/**
 * Toasts.
 *
 * Deliberately few and short-lived: the app already has undo for destructive
 * actions and a save indicator in the title bar, so toasts only carry things
 * that would otherwise be missed — a failed write, a completed export, a note
 * that has been moved to the trash.
 */

import { $, el, icon, replace } from './dom.js';

const stack = $('#toastStack');

/** Dismiss a toast, playing its exit animation first. */
function dismiss(node) {
  if (!node.isConnected || node.classList.contains('is-leaving')) return;
  node.classList.add('is-leaving');
  const remove = () => node.remove();
  node.addEventListener('animationend', remove, { once: true });
  // Guard against the animation being suppressed by reduced-motion settings.
  setTimeout(remove, 400);
}

/**
 * Show a toast.
 *
 * @param {string} message
 * @param {object} [options]
 * @param {string} [options.iconName] sprite id shown at the start
 * @param {string} [options.action] label for the trailing button
 * @param {() => void} [options.onAction]
 * @param {number} [options.duration] ms before auto-dismiss; 0 keeps it open
 */
export function toast(message, { iconName, action, onAction, duration = 4200 } = {}) {
  const node = el('div', { class: 'toast', role: 'status' }, [
    iconName ? icon(iconName) : null,
    el('span', { text: message }),
  ]);

  const iconNode = node.querySelector('svg');
  if (iconNode) iconNode.classList.add('toast-icon');

  if (action && onAction) {
    node.append(
      el('button', {
        class: 'toast-action',
        type: 'button',
        text: action,
        onClick: () => {
          onAction();
          dismiss(node);
        },
      }),
    );
  }

  stack.append(node);

  if (duration > 0) {
    setTimeout(() => dismiss(node), duration);
  }

  // Hovering holds the toast open, which matters for undo-style actions.
  let resume = null;
  node.addEventListener('pointerenter', () => {
    if (resume) clearTimeout(resume);
  });
  node.addEventListener('pointerleave', () => {
    if (duration > 0) resume = setTimeout(() => dismiss(node), 1600);
  });

  return { dismiss: () => dismiss(node) };
}

/**
 * Show an error that is worth interrupting for, with a retry affordance.
 *
 * Failures to save are the one class of problem this app must never hide, so
 * they get a persistent toast rather than a flash.
 */
export function reportError(message, onRetry) {
  return toast(message, {
    iconName: 'i-alert',
    action: onRetry ? 'Retry' : undefined,
    onAction: onRetry,
    duration: onRetry ? 0 : 7000,
  });
}

/** Replace the stack's contents — used on shutdown and when resetting state. */
export function clearToasts() {
  replace(stack, []);
}
