'use strict';

// Only an explicit authorization rejection should invalidate credentials.
// Network failures, rate limits and unavailable storage cannot verify them.
exports.isAuthenticationFailure = function isAuthenticationFailure (request) {
  return request && (request.status === 401 || request.status === 403);
};

function storageQuotaKind (request) {
  var code = request && request.responseJSON && request.responseJSON.error && request.responseJSON.error.code;
  if (code === 'storage_read_quota_exceeded') return 'read';
  if (code === 'storage_write_quota_exceeded') return 'write';
  return null;
}

exports.retryDelay = function retryDelay (request, failures) {
  var backoff = Math.min(60000, 5000 * Math.pow(2, Math.min(failures || 0, 4)));
  var header = request && typeof request.getResponseHeader === 'function' ? request.getResponseHeader('Retry-After') : null;
  var delay = NaN;
  if (typeof header === 'string') {
    header = header.trim();
    if (/^\d+$/.test(header)) delay = Number(header) * 1000;
    else if (/GMT$/.test(header)) delay = Date.parse(header) - Date.now();
  }
  if (!Number.isFinite(delay) && storageQuotaKind(request)) {
    var now = new Date();
    delay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - Date.now();
  }
  // Keep setTimeout within its signed 32-bit range; an overflow retries at once.
  return Math.max(backoff, Math.min(2147483647, Number.isFinite(delay) ? delay : 0));
};

exports.showTemporaryFailure = function showTemporaryFailure ($, request, delay) {
  var kind = storageQuotaKind(request);
  var message = kind ? 'Storage ' + kind + ' quota reached.'
    : request && request.status ? 'Nightscout is temporarily unavailable.' : 'Cannot reach the Nightscout server.';
  message += ' Retrying in ' + Math.ceil(delay / 1000) + ' seconds.';
  // All text is locally generated. Never display arbitrary upstream errors,
  // response bodies, request headers, URLs or credentials in the page.
  $('#centerMessagePanel').show();
  $('#loadingMessageText').html(message);
  $('#authenticationmessage').html(message);
};
