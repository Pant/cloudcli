import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Queue, QueueItem, QueueItemContent, QueueItemIndicator } from './Queue';

const renderQueue = () => renderToStaticMarkup(
  <Queue>
    <QueueItem status="completed">
      <QueueItemIndicator />
      <QueueItemContent>Finished item</QueueItemContent>
    </QueueItem>
    <QueueItem status="in_progress">
      <QueueItemIndicator />
      <QueueItemContent>Current item</QueueItemContent>
    </QueueItem>
    <QueueItem status="pending">
      <QueueItemIndicator />
      <QueueItemContent>Waiting item</QueueItemContent>
    </QueueItem>
  </Queue>,
);

test('renders queue status markers without perpetual animation', () => {
  const html = renderQueue();

  assert.match(html, /data-status="completed"/);
  assert.match(html, /data-status="in_progress"/);
  assert.match(html, /data-status="pending"/);
  assert.match(html, /bg-blue-500 ring-2 ring-blue-500\/20/);
  assert.doesNotMatch(html, /animate-(?:spin|pulse)/);
});
