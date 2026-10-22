// attachments.js
//
// A short-lived in-memory shelf for files the user has uploaded.
//
// The browser uploads a file once, the server reads it and keeps the extracted
// text (or the image bytes) here under an id, and the next question carries
// that id. That keeps the file content on the server instead of bouncing it
// back and forth through the chat request, and means the prompt builder is the
// only place that decides how a file is presented to the model.
//
// Nothing is written to disk and nothing survives a restart, which is what we
// want for student documents.

'use strict';

const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000;   // files are forgotten after 30 minutes
const MAX_FILES = 10;            // per conversation

const store = new Map();

// Keep the timers from holding the process open (matters for the test run).
function scheduleExpiry(id) {
  const timer = setTimeout(() => store.delete(id), TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Put a read file on the shelf.
 *
 * @param {{filename: string, kind: string, text?: string,
 *          image?: {mimeType: string, data: string}}} attachment
 * @returns {string} the id the client sends back with its question
 */
function save(attachment) {
  const id = crypto.randomUUID();
  store.set(id, { ...attachment, createdAt: Date.now() });
  scheduleExpiry(id);

  // Drop the oldest file if the shelf is getting crowded.
  while (store.size > MAX_FILES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    store.delete(oldest[0]);
  }

  return id;
}

/**
 * Fetch a stored attachment, or null when the id is unknown or expired.
 *
 * @param {string} id
 */
function get(id) {
  if (!id) return null;
  const attachment = store.get(id);
  if (!attachment) return null;
  if (Date.now() - attachment.createdAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  return attachment;
}

/**
 * Fetch several attachments, dropping any that are missing or expired.
 *
 * @param {string[]} ids
 */
function getMany(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => get(id)).filter(Boolean);
}

function clear() {
  store.clear();
}

function count() {
  return store.size;
}

module.exports = { save, get, getMany, clear, count, TTL_MS, MAX_FILES };
