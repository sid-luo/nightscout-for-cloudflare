'use strict';

var Storages = require('js-storage');
var textAsHtml = require('../utils/html').textAsHtml;
var requestErrors = require('./request-errors');

function canUseSubtleCrypto () {
  return typeof window !== 'undefined'
    && window.crypto
    && window.crypto.subtle
    && typeof window.crypto.subtle.digest === 'function'
    && typeof TextEncoder !== 'undefined';
}

function bytesToHex (bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var byteHex = bytes[i].toString(16);
    hex += byteHex.length === 1 ? '0' + byteHex : byteHex;
  }
  return hex;
}

function wordToHex (word) {
  var hex = (word >>> 0).toString(16);
  return '00000000'.slice(hex.length) + hex;
}

function rotateLeft (value, bits) {
  return (value << bits) | (value >>> (32 - bits));
}

function utf8Bytes (value) {
  if (typeof TextEncoder !== 'undefined') {
    return Array.prototype.slice.call(new TextEncoder().encode(value));
  }

  var bytes = [];
  for (var i = 0; i < value.length; i++) {
    var codePoint = value.charCodeAt(i);

    if (codePoint >= 0xD800 && codePoint <= 0xDBFF) {
      var next = value.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (next - 0xDC00);
        i++;
      } else {
        codePoint = 0xFFFD;
      }
    } else if (codePoint >= 0xDC00 && codePoint <= 0xDFFF) {
      codePoint = 0xFFFD;
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(
        0xC0 | (codePoint >> 6)
        , 0x80 | (codePoint & 0x3F)
      );
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xE0 | (codePoint >> 12)
        , 0x80 | ((codePoint >> 6) & 0x3F)
        , 0x80 | (codePoint & 0x3F)
      );
    } else {
      bytes.push(
        0xF0 | (codePoint >> 18)
        , 0x80 | ((codePoint >> 12) & 0x3F)
        , 0x80 | ((codePoint >> 6) & 0x3F)
        , 0x80 | (codePoint & 0x3F)
      );
    }
  }
  return bytes;
}

function sha1Fallback (value) {
  var bytes = utf8Bytes(value);
  var bitLength = bytes.length * 8;

  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) {
    bytes.push(0);
  }

  var bitLengthHigh = Math.floor(bitLength / 0x100000000);
  var bitLengthLow = bitLength >>> 0;
  bytes.push(
    (bitLengthHigh >>> 24) & 0xFF
    , (bitLengthHigh >>> 16) & 0xFF
    , (bitLengthHigh >>> 8) & 0xFF
    , bitLengthHigh & 0xFF
    , (bitLengthLow >>> 24) & 0xFF
    , (bitLengthLow >>> 16) & 0xFF
    , (bitLengthLow >>> 8) & 0xFF
    , bitLengthLow & 0xFF
  );

  var h0 = 0x67452301;
  var h1 = 0xEFCDAB89;
  var h2 = 0x98BADCFE;
  var h3 = 0x10325476;
  var h4 = 0xC3D2E1F0;

  for (var offset = 0; offset < bytes.length; offset += 64) {
    var words = [];
    for (var i = 0; i < 16; i++) {
      var index = offset + (i * 4);
      words[i] = (
        (bytes[index] << 24)
        | (bytes[index + 1] << 16)
        | (bytes[index + 2] << 8)
        | bytes[index + 3]
      );
    }

    for (i = 16; i < 80; i++) {
      words[i] = rotateLeft(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    }

    var a = h0;
    var b = h1;
    var c = h2;
    var d = h3;
    var e = h4;

    for (i = 0; i < 80; i++) {
      var f;
      var k;

      if (i < 20) {
        f = (b & c) | ((~b) & d);
        k = 0x5A827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDC;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6;
      }

      var temp = (rotateLeft(a, 5) + f + e + k + words[i]) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return wordToHex(h0) + wordToHex(h1) + wordToHex(h2) + wordToHex(h3) + wordToHex(h4);
}

async function sha1Hex (value) {
  if (canUseSubtleCrypto()) {
    try {
      var encoded = new TextEncoder().encode(value);
      var hashBuffer = await window.crypto.subtle.digest('SHA-1', encoded);
      return bytesToHex(new Uint8Array(hashBuffer));
    } catch (error) {
      console.warn('Falling back to JavaScript SHA-1 implementation:', error);
    }
  }

  return sha1Fallback(value);
}

var hashauth = {
  initialized: false
};

hashauth.init = function init (client, $) {

  hashauth.apisecret = '';
  hashauth.storeapisecret = false;
  hashauth.apisecrethash = null;
  hashauth.authenticated = false;
  hashauth.tokenauthenticated = false;
  hashauth.hasReadPermission = false;
  hashauth.isAdmin = false;
  hashauth.hasWritePermission = false;
  hashauth.permissionlevel = 'NONE';
  var verificationAttempt = 0;
  var secretAttempt = 0;
  var verificationRetryTimer = null;
  var verifiedCredentials = null;

  function cancelVerification () {
    verificationAttempt++;
    if (verificationRetryTimer !== null) {
      window.clearTimeout(verificationRetryTimer);
      verificationRetryTimer = null;
    }
  }

  function resetPermissions () {
    hashauth.authenticated = false;
    hashauth.tokenauthenticated = false;
    hashauth.hasReadPermission = false;
    hashauth.hasWritePermission = false;
    hashauth.isAdmin = false;
    hashauth.permissionlevel = 'NONE';
  }

  hashauth.verifyAuthentication = function verifyAuthentication (next, candidateDigest) {
    cancelVerification();
    var attempt = verificationAttempt;
    var failures = 0;
    var temporaryFailure = false;
    var isCandidate = typeof candidateDigest === 'string';

    function denied (failure) {
      // A rejected form submission says nothing about the still-active session.
      // Ordinary revalidation of that session must still revoke on denial.
      if (!isCandidate) hashauth.removeAuthentication();
      next(false, failure);
    }

    function retryVerification (request) {
      if (attempt !== verificationAttempt || verificationRetryTimer !== null) return;
      var delay = requestErrors.retryDelay(request, failures++);
      hashauth.injectHtml();
      requestErrors.showTemporaryFailure($, request, delay);
      temporaryFailure = true;
      verificationRetryTimer = window.setTimeout(function retryAfterDelay () {
        verificationRetryTimer = null;
        if (attempt === verificationAttempt) verify();
      }, delay);
    }

    function verify () {
      // Never let a valid Bearer session authenticate a different form input.
      // Keep the active credential intact until this exact candidate succeeds.
      var headers = isCandidate ? { 'api-secret': candidateDigest } : client.headers();
      var credentials = JSON.stringify(headers);
      // Retain previously verified permissions through an outage only while
      // checking the same credential. A newly entered secret grants nothing.
      if (!isCandidate && credentials !== verifiedCredentials) resetPermissions();
      var settled = false;

      function acceptCurrentResponse () {
        if (attempt !== verificationAttempt || settled) return false;
        settled = true;
        if (!isCandidate && credentials !== JSON.stringify(client.headers())) {
          // A background JWT refresh does not call verifyAuthentication and
          // therefore does not advance its attempt. Discard the old result
          // and recheck the current credential with the same bounded backoff.
          resetPermissions();
          retryVerification({ status: 503 });
          return false;
        }
        return true;
      }

      $.ajax({
        method: 'GET'
        , url: '/api/v1/verifyauth?t=' + Date.now() //cache buster
        , headers: headers
        , timeout: 30000
      }).done(function verifysuccess (response) {
        if (!acceptCurrentResponse()) return;
        var message = response && response.message;
        var tokenFound = message && message.rolefound === 'FOUND';
        var authorized = message === 'OK' || message && message.message === 'OK';
        if (authorized || tokenFound && !isCandidate) {
          if (isCandidate) {
            client.authorized = null;
            hashauth.apisecrethash = candidateDigest;
          }
          // Refresh every flag, including permission reductions and token/admin
          // transitions; retaining a previous true flag would hide revocation.
          resetPermissions();
          hashauth.hasReadPermission = !!message.canRead;
          hashauth.hasWritePermission = !!message.canWrite;
          hashauth.isAdmin = !!message.isAdmin;
          hashauth.permissionlevel = message.permissions || 'NONE';
          hashauth.tokenauthenticated = !!tokenFound;
          hashauth.authenticated = !tokenFound;
          verifiedCredentials = credentials;
          if (temporaryFailure) {
            $('#authenticationmessage').html('');
            $('#centerMessagePanel').hide();
          }
          next(true);
          return;
        }
        if (message === 'UNAUTHORIZED' || message && message.message === 'UNAUTHORIZED') {
          denied();
          return;
        }
        // A malformed success response is a service failure, not evidence that
        // the user's secret is wrong.
        retryVerification({ status: 502 });
      }).fail(function verifyfail (err) {
        if (!acceptCurrentResponse()) return;
        if (requestErrors.isAuthenticationFailure(err)) {
          denied({ status: err.status });
        } else {
          retryVerification(err);
        }
      });
    }
    verify();
  };

  hashauth.injectHtml = function injectHtml () {
    if (!hashauth.injectedHtml) {
      $('#authentication_placeholder').html(hashauth.inlineCode());
      hashauth.injectedHtml = true;
    }
  };

  hashauth.initAuthentication = function initAuthentication (next) {
    hashauth.apisecrethash = hashauth.apisecrethash || Storages.localStorage.get('apisecrethash') || null;
    hashauth.verifyAuthentication(function() {
      hashauth.injectHtml();
      if (next) { next(hashauth.isAuthenticated()); }
    });
    return hashauth;
  };

  hashauth.removeAuthentication = function removeAuthentication (event) {
    cancelVerification();
    var wasAuthenticated = hashauth.authenticated || hashauth.tokenauthenticated;
    Storages.localStorage.remove('apisecrethash');
    // clear everything just in case
    hashauth.apisecret = null;
    hashauth.apisecrethash = null;
    verifiedCredentials = null;
    resetPermissions();
    client.authorized = null;
    if (wasAuthenticated) client.browserUtils.reload();

    if (event) {
      event.preventDefault();
    }
    return false;
  };

  hashauth.requestAuthentication = function requestAuthentication (eventOrNext) {
    var translate = client.translate;
    hashauth.injectHtml();

    var clientWidth = window.innerWidth ||
      document.documentElement.clientWidth ||
      document.body.clientWidth;

    clientWidth = Math.min(400, clientWidth);

    $('#requestauthenticationdialog').dialog({
      width: clientWidth
      , height: 270
      , closeText: ''
      , buttons: [
        {
          id: 'requestauthenticationdialog-btn'
          , text: translate('Authenticate')
          , click: function() {
            var dialog = this;
            hashauth.processSecret($('#apisecret').val(), $('#storeapisecret').is(':checked'), function done (close) {
              if (close) {
                if (eventOrNext && eventOrNext.call) {
                  eventOrNext(true);
                } else {
                  client.afterAuth(true);
                }
                $(dialog).dialog('close');
              } else {
                $('#apisecret').val('').focus();
              }
            });
          }
        }
      ]
      , open: function open () {
        $('#apisecret').off('keyup').on('keyup', function pressed (e) {
          if (e.keyCode === $.ui.keyCode.ENTER) {
            $('#requestauthenticationdialog-btn').trigger('click');
          }
        });
        $('#apisecret').val('').focus();
      }

    });

    if (eventOrNext && eventOrNext.preventDefault) {
      eventOrNext.preventDefault();
    }
    return false;
  };

  hashauth.processSecret = async function processSecret (apisecret, storeapisecret, callback) {
    var translate = client.translate;
    var submission = ++secretAttempt;
    // A locally rejected submission also replaces the previous form action.
    // It must not leave an older HTTP request or quota retry able to sign in.
    cancelVerification();
    var attempt = verificationAttempt;
    var remember = storeapisecret;

    if (!apisecret || apisecret.length < 12) {
      window.alert(translate('Too short API secret'));
      if (callback) {
        callback(false);
      }
    } else {
      try {
        var digest = await sha1Hex(apisecret);
        if (submission !== secretAttempt || attempt !== verificationAttempt) return;
        hashauth.verifyAuthentication(function(isok, failure) {
          if (submission !== secretAttempt) return;
          if (isok) {
            hashauth.apisecret = apisecret;
            hashauth.storeapisecret = remember;
            hashauth.apisecrethash = digest;
            if (remember) {
              Storages.localStorage.set('apisecrethash', digest);
              // TODO show dialog first, then reload
              if (hashauth.tokenauthenticated) client.browserUtils.reload();
            } else {
              // A successful unchecked switch must not reload into an older
              // remembered identity. Failed or pending candidates leave it alone.
              Storages.localStorage.remove('apisecrethash');
            }
            $('#authentication_placeholder').html(hashauth.inlineCode());
            if (callback) {
              callback(true);
            }
          } else {
            window.alert(translate(failure && failure.status === 403 ? 'Access denied for this secret or token' : 'Wrong API secret'));
            if (callback) {
              callback(false);
            }
          }
        }, digest);
      } catch (error) {
        if (submission !== secretAttempt) return;
        console.error('Error hashing API secret:', error);
        if (callback) {
          callback(false);
        }
      }
    }
  };

  hashauth.inlineCode = function inlineCode () {
    var translate = client.translate;

    var status = null;

    if (!hashauth.isAdmin) {
      $('.needsadminaccess').hide();
    } else {
      $('.needsadminaccess').show();
    }

    if (client.updateAdminMenu) client.updateAdminMenu();

    if (client.authorized || hashauth.tokenauthenticated) {
      status = translate('Authorized by token');
      if (client.authorized && client.authorized.sub) {
        status += '<br>' + translate('Auth role') + ': ' + textAsHtml(client.authorized.sub);
        if (hashauth.hasReadPermission) {  status += '<br>' + translate('Data reads enabled'); }
        if (hashauth.hasWritePermission) { status += '<br>' + translate('Data writes enabled'); }
        if (!hashauth.hasWritePermission) { status += '<br>' + translate('Data writes not enabled'); }
      }
      if (hashauth.apisecrethash) {
        status += '<br> <a href="#" onclick="Nightscout.client.hashauth.removeAuthentication(); return false;">(' + translate('Remove stored token') + ')</a>';
      } else {
        status += '<br><a href="/">(' + translate('view without token') + ')</a>';
      }

    } else if (hashauth.isAuthenticated()) {
      status = translate('Admin authorized') + ' <a href="#" onclick="Nightscout.client.hashauth.removeAuthentication(); return false;">(' + translate('Remove') + ')</a>';
    } else {
      status = translate('Unauthorized') +
        '<br>' +
        translate('Reads enabled in default permissions') +
        '<br>' +
        ' <a href="#" onclick="Nightscout.client.hashauth.requestAuthentication(); return false;">(' +
        translate('Authenticate') + ')</a>';
    }

    var html =
      '<div id="requestauthenticationdialog" style="display:none" title="' + translate('Device authentication') + '">' +
      '<label for="apisecret">' + translate('Your API secret or token') + ': </label>' +
      '<input type="password" id="apisecret" size="20" style="width: 100%;"/>' +
      '<div id="authenticationmessage" role="status"></div>' +
      '<br>' +
      '<input type="checkbox" id="storeapisecret" /> <label for="storeapisecret">' + translate('Remember this device. (Do not enable this on public computers.)') + '</label>' +
      '</div>' +
      '<div id="authorizationstatus">' + status + '</div>';

    return html;
  };

  hashauth.updateSocketAuth = function updateSocketAuth () {
    client.socket.emit(
      'authorize'
      , {
        client: 'web'
        , secret: client.authorized && client.authorized.token ? null : client.hashauth.hash()
        , token: client.authorized && client.authorized.token
      }
      , function authCallback (data) {
        if (!data.read && !client.authorized) {
          hashauth.requestAuthentication();
        }
      }
    );
  };

  hashauth.hash = function hash () {
    return hashauth.apisecrethash;
  };

  hashauth.isAuthenticated = function isAuthenticated () {
    return hashauth.authenticated || hashauth.tokenauthenticated;
  };

  hashauth.initialized = true;

  return hashauth;
}

module.exports = hashauth;
