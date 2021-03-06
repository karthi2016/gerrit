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

  const TOKENIZE_REGEX = /(?:[^\s"]+|"[^"]*")+/g;

  Polymer({
    is: 'gr-autocomplete',

    /**
     * Fired when a value is chosen.
     *
     * @event commit
     */

    /**
     * Fired when the user cancels.
     *
     * @event cancel
     */

    /**
     * Fired on keydown to allow for custom hooks into autocomplete textbox
     * behavior.
     *
     * @event input-keydown
     */

    properties: {

      /**
       * Query for requesting autocomplete suggestions. The function should
       * accept the input as a string parameter and return a promise. The
       * promise should yield an array of suggestion objects with "name" and
       * "value" properties. The "name" property will be displayed in the
       * suggestion entry. The "value" property will be emitted if that
       * suggestion is selected.
       *
       * @type {function(String): Promise<Array<Object>>}
       */
      query: {
        type: Function,
        value() {
          return function() {
            return Promise.resolve([]);
          };
        },
      },

      /**
       * The number of characters that must be typed before suggestions are
       * made.
       */
      threshold: {
        type: Number,
        value: 1,
      },

      borderless: Boolean,
      disabled: Boolean,

      text: {
        type: String,
        value: '',
        observer: '_updateSuggestions',
        notify: true,
      },

      placeholder: String,

      clearOnCommit: {
        type: Boolean,
        value: false,
      },

      /**
       * When true, tab key autocompletes but does not fire the commit event.
       * See Issue 4556.
       */
      tabCompleteWithoutCommit: {
        type: Boolean,
        value: false,
      },

      value: Object,

      /**
       * Multi mode appends autocompleted entries to the value.
       * If false, autocompleted entries replace value.
       */
      multi: {
        type: Boolean,
        value: false,
      },

      _suggestions: {
        type: Array,
        value() { return []; },
      },

      _suggestionEls: {
        type: Array,
        value() { return []; },
      },

      _index: Number,
      _disableSuggestions: {
        type: Boolean,
        value: false,
      },
      _focused: {
        type: Boolean,
        value: false,
      },
      _selected: Object,
    },

    attached() {
      this.listen(document.body, 'tap', '_handleBodyTap');
    },

    detached() {
      this.unlisten(document.body, 'tap', '_handleBodyTap');
    },

    get focusStart() {
      return this.$.input;
    },

    focus() {
      this.$.input.focus();
    },

    selectAll() {
      this.$.input.setSelectionRange(0, this.$.input.value.length);
    },

    clear() {
      this.text = '';
    },

    _handleItemSelect(e) {
      let silent = false;
      if (e.detail.trigger === 'tab' && this.tabCompleteWithoutCommit) {
        silent = true;
      }
      this._selected = e.detail.selected;
      this._commit(silent);
      if (e.detail.trigger === 'tap') {
        this.focus();
      }
    },

    /**
     * Set the text of the input without triggering the suggestion dropdown.
     * @param {String} text The new text for the input.
     */
    setText(text) {
      this._disableSuggestions = true;
      this.text = text;
      this._disableSuggestions = false;
    },

    _onInputFocus() {
      this._focused = true;
      this._updateSuggestions();
    },

    _updateSuggestions() {
      if (!this.text || this._disableSuggestions) { return; }
      if (this.text.length < this.threshold) {
        this._suggestions = [];
        this.value = null;
        return;
      }
      const text = this.text;

      this.query(text).then(suggestions => {
        if (text !== this.text) {
          // Late response.
          return;
        }
        for (const suggestion of suggestions) {
          suggestion.text = suggestion.name;
        }
        this._suggestions = suggestions;
        Polymer.dom.flush();
        if (this._index === -1) {
          this.value = null;
        }
      });
    },

    _computeSuggestionsHidden(suggestions, focused) {
      return !(suggestions.length && focused);
    },

    _computeClass(borderless) {
      return borderless ? 'borderless' : '';
    },

    /**
     * _handleKeydown used for key handling in the this.$.input AND all child
     * autocomplete options.
     */
    _handleKeydown(e) {
      this._focused = true;
      switch (e.keyCode) {
        case 38: // Up
          e.preventDefault();
          this.$.suggestions.cursorUp();
          break;
        case 40: // Down
          e.preventDefault();
          this.$.suggestions.cursorDown();
          break;
        case 27: // Escape
          e.preventDefault();
          this._cancel();
          break;
        case 9: // Tab
          if (this._suggestions.length > 0) {
            e.preventDefault();
            this._handleEnter(this.tabCompleteWithoutCommit);
          }
          break;
        case 13: // Enter
          e.preventDefault();
          this._handleEnter();
          break;
        default:
          // For any normal keypress, return focus to the input to allow for
          // unbroken user input.
          this.$.input.focus();
      }
      this.fire('input-keydown', {keyCode: e.keyCode, input: this.$.input});
    },

    _cancel() {
      if (this._suggestions.length) {
        this._suggestions = [];
      } else {
        this.fire('cancel');
      }
    },

    _handleEnter(opt_tabCompleteWithoutCommit) {
      this._selected = this.$.suggestions.getCursorTarget();
      this._commit(opt_tabCompleteWithoutCommit);
      this.focus();
    },

    _updateValue(suggestion, suggestions) {
      if (!suggestion) { return; }
      const completed = suggestions[suggestion.dataset.index].value;
      if (this.multi) {
        // Append the completed text to the end of the string.
        // Allow spaces within quoted terms.
        const tokens = this.text.match(TOKENIZE_REGEX);
        tokens[tokens.length - 1] = completed;
        this.value = tokens.join(' ');
      } else {
        this.value = completed;
      }
    },

    _handleBodyTap(e) {
      const eventPath = Polymer.dom(e).path;
      for (let i = 0; i < eventPath.length; i++) {
        if (eventPath[i] === this) {
          return;
        }
      }
      this._focused = false;
    },

    _handleSuggestionTap(e) {
      e.stopPropagation();
      this.$.cursor.setCursor(e.target);
      this._commit();
      this.focus();
    },

    /**
     * Commits the suggestion, optionally firing the commit event.
     *
     * @param {Boolean} silent Allows for silent committing of an autocomplete
     *     suggestion in order to handle cases like tab-to-complete without
     *     firing the commit event.
     */
    _commit(silent) {
      // Allow values that are not in suggestion list iff suggestions are empty.
      if (this._suggestions.length > 0) {
        this._updateValue(this._selected, this._suggestions);
      } else {
        this.value = this.text || '';
      }

      const value = this.value;

      // Value and text are mirrors of each other in multi mode.
      if (this.multi) {
        this.setText(this.value);
      } else {
        if (!this.clearOnCommit && this._selected) {
          this.setText(this._suggestions[this._selected.dataset.index].name);
        } else {
          this.clear();
        }
      }

      this._suggestions = [];
      if (!silent) {
        this.fire('commit', {value});
      }
    },
  });
})();
