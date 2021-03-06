// Copyright (C) 2016 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
(function() {
  'use strict';

  const STORAGE_DEBOUNCE_INTERVAL_MS = 400;

  const FocusTarget = {
    ANY: 'any',
    BODY: 'body',
    CCS: 'cc',
    REVIEWERS: 'reviewers',
  };

  const ReviewerTypes = {
    REVIEWER: 'REVIEWER',
    CC: 'CC',
  };

  const LatestPatchState = {
    LATEST: 'latest',
    CHECKING: 'checking',
    NOT_LATEST: 'not-latest',
  };

  Polymer({
    is: 'gr-reply-dialog',

    /**
     * Fired when a reply is successfully sent.
     *
     * @event send
     */

    /**
     * Fired when the user presses the cancel button.
     *
     * @event cancel
     */

    /**
     * Fired when the main textarea's value changes, which may have triggered
     * a change in size for the dialog.
     *
     * @event autogrow
     */

    /**
     * Fires to show an alert when a send is attempted on the non-latest patch.
     *
     * @event show-alert
     */

    properties: {
      change: Object,
      patchNum: String,
      canBeStarted: {
        type: Boolean,
        value: false,
      },
      disabled: {
        type: Boolean,
        value: false,
        reflectToAttribute: true,
      },
      draft: {
        type: String,
        value: '',
        observer: '_draftChanged',
      },
      quote: {
        type: String,
        value: '',
      },
      diffDrafts: Object,
      filterReviewerSuggestion: {
        type: Function,
        value() {
          return this._filterReviewerSuggestion.bind(this);
        },
      },
      permittedLabels: Object,
      serverConfig: Object,
      projectConfig: Object,
      knownLatestState: String,
      underReview: {
        type: Boolean,
        value: true,
      },

      _account: Object,
      _ccs: Array,
      _ccPendingConfirmation: {
        type: Object,
        observer: '_reviewerPendingConfirmationUpdated',
      },
      _messagePlaceholder: {
        type: String,
        computed: '_computeMessagePlaceholder(canBeStarted)',
      },
      _owner: Object,
      _pendingConfirmationDetails: Object,
      _includeComments: {
        type: Boolean,
        value: true,
      },
      _reviewers: Array,
      _reviewerPendingConfirmation: {
        type: Object,
        observer: '_reviewerPendingConfirmationUpdated',
      },
      _previewFormatting: {
        type: Boolean,
        value: false,
        observer: '_handleHeightChanged',
      },
      _reviewersPendingRemove: {
        type: Object,
        value: {
          CC: [],
          REVIEWER: [],
        },
      },
      _sendButtonLabel: {
        type: String,
        computed: '_computeSendButtonLabel(canBeStarted)',
      },
    },

    FocusTarget,

    behaviors: [
      Gerrit.BaseUrlBehavior,
      Gerrit.KeyboardShortcutBehavior,
      Gerrit.PatchSetBehavior,
      Gerrit.RESTClientBehavior,
    ],

    keyBindings: {
      esc: '_handleEscKey',
    },

    observers: [
      '_changeUpdated(change.reviewers.*, change.owner, serverConfig)',
      '_ccsChanged(_ccs.splices)',
      '_reviewersChanged(_reviewers.splices)',
    ],

    attached() {
      this._getAccount().then(account => {
        this._account = account || {};
      });
    },

    ready() {
      this.$.jsAPI.addElement(this.$.jsAPI.Element.REPLY_DIALOG, this);
    },

    open(opt_focusTarget) {
      this.knownLatestState = LatestPatchState.CHECKING;
      this.fetchIsLatestKnown(this.change, this.$.restAPI)
          .then(isUpToDate => {
            this.knownLatestState = isUpToDate ?
                LatestPatchState.LATEST : LatestPatchState.NOT_LATEST;
          });

      this._focusOn(opt_focusTarget);
      if (!this.draft || !this.draft.length) {
        this.draft = this._loadStoredDraft();
      }
    },

    focus() {
      this._focusOn(FocusTarget.ANY);
    },

    getFocusStops() {
      return {
        start: this.$.reviewers.focusStart,
        end: this.$.cancelButton,
      };
    },

    setLabelValue(label, value) {
      const selectorEl =
          this.$.labelScores.$$('iron-selector[data-label="' + label + '"]');
      // The selector may not be present if it’s not at the latest patch set.
      if (!selectorEl) { return; }
      const item = selectorEl.$$('gr-button[data-value="' + value + '"]');
      if (!item) { return; }
      selectorEl.selectIndex(selectorEl.indexOf(item));
    },

    _handleEscKey(e) {
      this.cancel();
    },

    _ccsChanged(splices) {
      if (splices && splices.indexSplices) {
        this._processReviewerChange(splices.indexSplices, ReviewerTypes.CC);
      }
    },

    _reviewersChanged(splices) {
      if (splices && splices.indexSplices) {
        this._processReviewerChange(splices.indexSplices,
            ReviewerTypes.REVIEWER);
      }
    },

    _processReviewerChange(indexSplices, type) {
      for (const splice of indexSplices) {
        for (const account of splice.removed) {
          if (!this._reviewersPendingRemove[type]) {
            console.err('Invalid type ' + type + ' for reviewer.');
            return;
          }
          this._reviewersPendingRemove[type].push(account);
        }
      }
    },

    /**
     * Resets the state of the _reviewersPendingRemove object, and removes
     * accounts if necessary.
     *
     * @param {Boolean} isCancel true if the action is a cancel.
     * @param {Object} opt_accountIdsTransferred map of account IDs that must
     *     not be removed, because they have been readded in another state.
     */
    _purgeReviewersPendingRemove(isCancel, opt_accountIdsTransferred) {
      let reviewerArr;
      const keep = opt_accountIdsTransferred || {};
      for (const type in this._reviewersPendingRemove) {
        if (this._reviewersPendingRemove.hasOwnProperty(type)) {
          if (!isCancel) {
            reviewerArr = this._reviewersPendingRemove[type];
            for (let i = 0; i < reviewerArr.length; i++) {
              if (!keep[reviewerArr[i]._account_id]) {
                this._removeAccount(reviewerArr[i], type);
              }
            }
          }
          this._reviewersPendingRemove[type] = [];
        }
      }
    },

    /**
     * Removes an account from the change, both on the backend and the client.
     * Does nothing if the account is a pending addition.
     *
     * @param {Object} account
     * @param {ReviewerTypes} type
     */
    _removeAccount(account, type) {
      if (account._pendingAdd) { return; }

      return this.$.restAPI.removeChangeReviewer(this.change._number,
          account._account_id).then(response => {
            if (!response.ok) { return response; }

            const reviewers = this.change.reviewers[type] || [];
            for (let i = 0; i < reviewers.length; i++) {
              if (reviewers[i]._account_id == account._account_id) {
                this.splice(['change', 'reviewers', type], i, 1);
                break;
              }
            }
          });
    },

    _mapReviewer(reviewer) {
      let reviewerId;
      let confirmed;
      if (reviewer.account) {
        reviewerId = reviewer.account._account_id || reviewer.account.email;
      } else if (reviewer.group) {
        reviewerId = reviewer.group.id;
        confirmed = reviewer.group.confirmed;
      }
      return {reviewer: reviewerId, confirmed};
    },

    send(includeComments) {
      if (this.knownLatestState === 'not-latest') {
        this.fire('show-alert',
            {message: 'Cannot reply to non-latest patch.'});
        return;
      }

      const labels = this.$.labelScores.getLabelValues();

      const obj = {
        drafts: includeComments ? 'PUBLISH_ALL_REVISIONS' : 'KEEP',
        labels,
      };

      if (this.draft != null) {
        obj.message = this.draft;
      }

      const accountAdditions = {};
      obj.reviewers = this.$.reviewers.additions().map(reviewer => {
        if (reviewer.account) {
          accountAdditions[reviewer.account._account_id] = true;
        }
        return this._mapReviewer(reviewer);
      });
      const ccsEl = this.$$('#ccs');
      if (ccsEl) {
        for (let reviewer of ccsEl.additions()) {
          if (reviewer.account) {
            accountAdditions[reviewer.account._account_id] = true;
          }
          reviewer = this._mapReviewer(reviewer);
          reviewer.state = 'CC';
          obj.reviewers.push(reviewer);
        }
      }

      this.disabled = true;

      const errFn = this._handle400Error.bind(this);
      return this._saveReview(obj, errFn).then(response => {
        if (!response || !response.ok) {
          return response;
        }
        this.disabled = false;
        this.draft = '';
        this._includeComments = true;
        this.fire('send', null, {bubbles: false});
        return accountAdditions;
      }).catch(err => {
        this.disabled = false;
        throw err;
      });
    },

    _focusOn(section) {
      if (section === FocusTarget.ANY) {
        section = this._chooseFocusTarget();
      }
      if (section === FocusTarget.BODY) {
        const textarea = this.$.textarea;
        textarea.async(textarea.textarea.focus.bind(textarea.textarea));
      } else if (section === FocusTarget.REVIEWERS) {
        const reviewerEntry = this.$.reviewers.focusStart;
        reviewerEntry.async(reviewerEntry.focus);
      } else if (section === FocusTarget.CCS) {
        const ccEntry = this.$$('#ccs').focusStart;
        ccEntry.async(ccEntry.focus);
      }
    },

    _chooseFocusTarget() {
      // If we are the owner and the reviewers field is empty, focus on that.
      if (this._account && this.change && this.change.owner &&
          this._account._account_id === this.change.owner._account_id &&
          (!this._reviewers || this._reviewers.length === 0)) {
        return FocusTarget.REVIEWERS;
      }

      // Default to BODY.
      return FocusTarget.BODY;
    },

    _handle400Error(response) {
      // A call to _saveReview could fail with a server error if erroneous
      // reviewers were requested. This is signalled with a 400 Bad Request
      // status. The default gr-rest-api-interface error handling would
      // result in a large JSON response body being displayed to the user in
      // the gr-error-manager toast.
      //
      // We can modify the error handling behavior by passing this function
      // through to restAPI as a custom error handling function. Since we're
      // short-circuiting restAPI we can do our own response parsing and fire
      // the server-error ourselves.
      //
      this.disabled = false;

      if (response.status !== 400) {
        // This is all restAPI does when there is no custom error handling.
        this.fire('server-error', {response});
        return response;
      }

      // Process the response body, format a better error message, and fire
      // an event for gr-event-manager to display.
      const jsonPromise = this.$.restAPI.getResponseObject(response);
      return jsonPromise.then(result => {
        const errors = [];
        for (const state of ['reviewers', 'ccs']) {
          for (const reviewer of result[state]) {
            if (reviewer.error) {
              errors.push(reviewer.error);
            }
          }
        }
        response = {
          ok: false,
          status: response.status,
          text() { return Promise.resolve(errors.join(', ')); },
        };
        this.fire('server-error', {response});
      });
    },

    _computeHideDraftList(drafts) {
      return Object.keys(drafts || {}).length == 0;
    },

    _computeDraftsTitle(drafts) {
      let total = 0;
      for (const file in drafts) {
        if (drafts.hasOwnProperty(file)) {
          total += drafts[file].length;
        }
      }
      if (total == 0) { return ''; }
      if (total == 1) { return '1 Draft'; }
      if (total > 1) { return total + ' Drafts'; }
    },

    _computeMessagePlaceholder(canBeStarted) {
      return canBeStarted ?
        'Add a note for your reviewers...' :
        'Say something nice...';
    },

    _changeUpdated(changeRecord, owner, serverConfig) {
      this._rebuildReviewerArrays(changeRecord.base, owner, serverConfig);
    },

    _rebuildReviewerArrays(change, owner, serverConfig) {
      this._owner = owner;

      let reviewers = [];
      const ccs = [];

      for (const key in change) {
        if (change.hasOwnProperty(key)) {
          if (key !== 'REVIEWER' && key !== 'CC') {
            console.warn('unexpected reviewer state:', key);
            continue;
          }
          for (const entry of change[key]) {
            if (entry._account_id === owner._account_id) {
              continue;
            }
            switch (key) {
              case 'REVIEWER':
                reviewers.push(entry);
                break;
              case 'CC':
                ccs.push(entry);
                break;
            }
          }
        }
      }

      if (serverConfig.note_db_enabled) {
        this._ccs = ccs;
      } else {
        this._ccs = [];
        reviewers = reviewers.concat(ccs);
      }
      this._reviewers = reviewers;
    },

    _accountOrGroupKey(entry) {
      return entry.id || entry._account_id;
    },

    _filterReviewerSuggestion(suggestion) {
      let entry;
      if (suggestion.account) {
        entry = suggestion.account;
      } else if (suggestion.group) {
        entry = suggestion.group;
      } else {
        console.warn('received suggestion that was neither account nor group:',
            suggestion);
      }
      if (entry._account_id === this._owner._account_id) {
        return false;
      }

      const key = this._accountOrGroupKey(entry);
      const finder = function(entry) {
        return this._accountOrGroupKey(entry) === key;
      }.bind(this);

      return this._reviewers.find(finder) === undefined &&
          this._ccs.find(finder) === undefined;
    },

    _getAccount() {
      return this.$.restAPI.getAccount();
    },

    _cancelTapHandler(e) {
      e.preventDefault();
      this.cancel();
    },

    cancel() {
      this.fire('cancel', null, {bubbles: false});
      this._purgeReviewersPendingRemove(true);
      this._rebuildReviewerArrays(this.change.reviewers, this._owner,
          this.serverConfig);
    },

    _saveTapHandler(e) {
      e.preventDefault();
      this.send(this._includeComments).then(keepReviewers => {
        this._purgeReviewersPendingRemove(false, keepReviewers);
      });
    },

    _sendTapHandler(e) {
      e.preventDefault();
      if (this.canBeStarted) {
        this._startReview()
            .then(() => {
              return this.send(this._includeComments);
            })
            .then(keepReviewers => {
              this._purgeReviewersPendingRemove(false, keepReviewers);
            });
        return;
      }
      this.send(this._includeComments).then(keepReviewers => {
        this._purgeReviewersPendingRemove(false, keepReviewers);
      });
    },

    _saveReview(review, opt_errFn) {
      return this.$.restAPI.saveChangeReview(this.change._number, this.patchNum,
          review, opt_errFn);
    },

    _startReview() {
      if (!this.canBeStarted) {
        return Promise.resolve();
      }
      return this.$.restAPI.startReview(this.change._number);
    },

    _reviewerPendingConfirmationUpdated(reviewer) {
      if (reviewer === null) {
        this.$.reviewerConfirmationOverlay.close();
      } else {
        this._pendingConfirmationDetails =
            this._ccPendingConfirmation || this._reviewerPendingConfirmation;
        this.$.reviewerConfirmationOverlay.open();
      }
    },

    _confirmPendingReviewer() {
      if (this._ccPendingConfirmation) {
        this.$$('#ccs').confirmGroup(this._ccPendingConfirmation.group);
        this._focusOn(FocusTarget.CCS);
      } else {
        this.$.reviewers.confirmGroup(this._reviewerPendingConfirmation.group);
        this._focusOn(FocusTarget.REVIEWERS);
      }
    },

    _cancelPendingReviewer() {
      this._ccPendingConfirmation = null;
      this._reviewerPendingConfirmation = null;

      const target =
          this._ccPendingConfirmation ? FocusTarget.CCS : FocusTarget.REVIEWERS;
      this._focusOn(target);
    },

    _getStorageLocation() {
      // Tests trigger this method without setting change.
      if (!this.change) { return {}; }
      return {
        changeNum: this.change._number,
        patchNum: this.patchNum,
        path: '@change',
      };
    },

    _loadStoredDraft() {
      const draft = this.$.storage.getDraftComment(this._getStorageLocation());
      return draft ? draft.message : '';
    },

    _draftChanged(newDraft, oldDraft) {
      this.debounce('store', () => {
        if (!newDraft.length && oldDraft) {
          // If the draft has been modified to be empty, then erase the storage
          // entry.
          this.$.storage.eraseDraftComment(this._getStorageLocation());
        } else if (newDraft.length) {
          this.$.storage.setDraftComment(this._getStorageLocation(),
              this.draft);
        }
      }, STORAGE_DEBOUNCE_INTERVAL_MS);
    },

    _handleHeightChanged(e) {
      // If the textarea resizes, we need to re-fit the overlay.
      this.debounce('autogrow', () => {
        this.fire('autogrow');
      });
    },

    _isState(knownLatestState, value) {
      return knownLatestState === value;
    },

    _reload() {
      // Load the current change without any patch range.
      location.href = this.getBaseUrl() + '/c/' + this.change._number;
    },

    _computeSendButtonLabel(canBeStarted) {
      return canBeStarted ? 'Start review' : 'Send';
    },
  });
})();
