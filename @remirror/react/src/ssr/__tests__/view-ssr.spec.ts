/**
 * @jest-environment node
 */

import { EditorState } from '@remirror/pm/state';
import { minDocument, createBaseManager } from '@remirror/test-fixtures';

import { createEditorView, EditorViewSSR } from '../ssr-prosemirror-view';
import { EMPTY_PARAGRAPH_NODE } from '@remirror/core';

const { schema, plugins } = createBaseManager().store;
const state = EditorState.create({
  doc: schema.nodeFromJSON(EMPTY_PARAGRAPH_NODE),
  schema,
  plugins,
});

test('createEditorView', () => {
  const view = createEditorView(
    { mount: minDocument.createElement('div') },
    {
      state,
      editable: () => {
        return true;
      },
    },
  );

  expect(view).toBeInstanceOf(EditorViewSSR);
  expect(view.destroy).toBeFunction();
  expect(view.state).toBe(state);
});

test('createEditorView:forceEnvironment', () => {
  expect(() =>
    createEditorView(
      { mount: minDocument.createElement('div') },
      {
        state,
        editable: () => {
          return true;
        },
      },
      'dom',
    ),
  ).toThrowErrorMatchingInlineSnapshot(`"Cannot read property 'add' of undefined"`);
});
