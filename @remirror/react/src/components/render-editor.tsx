import React, { cloneElement, Fragment, PureComponent, ReactNode, Ref } from 'react';

import {
  AnyCombinedUnion,
  bool,
  clamp,
  EDITOR_CLASS_NAME,
  EditorManager,
  EditorView as EditorViewType,
  ErrorConstant,
  fromHTML,
  FromToParameter,
  getDocument,
  invariant,
  isArray,
  isFunction,
  isNumber,
  isPlainObject,
  MakeRequired,
  object,
  ObjectNode,
  RemirrorContentType,
  SchemaFromCombined,
  shouldUseDOMEnvironment,
  toHTML,
  Transaction,
  uniqueId,
} from '@remirror/core';
import { EditorState, TextSelection } from '@remirror/pm/state';
import {
  addKeyToElement,
  getElementProps,
  isReactDOMElement,
  isRemirrorContextProvider,
  isRemirrorProvider,
  propIsFunction,
  RemirrorType,
} from '@remirror/react-utils';

import { PortalContainer } from '../portals';
import { defaultProps } from '../react-constants';
import {
  BaseListenerParameter,
  BaseProps,
  DefaultReactCombined,
  EditorStateEventListenerParameter,
  FocusType,
  GetRootPropsConfig,
  ListenerParameter,
  RefKeyRootProps,
  RemirrorContextProps,
  RemirrorEventListenerParameter,
  RemirrorState,
  RemirrorStateListenerParameter,
  UpdateStateParameter,
} from '../react-types';
import { createEditorView, RemirrorSSR } from '../ssr';

/**
 * A function that takes the injected remirror params and returns JSX to render.
 *
 * @param - injected remirror params
 */
type RenderPropFunction<Combined extends AnyCombinedUnion> = (
  params: RemirrorContextProps<Combined>,
) => JSX.Element;

export interface RenderEditorProps<Combined extends AnyCombinedUnion>
  extends MakeRequired<BaseProps<Combined>, keyof typeof defaultProps> {
  /**
   * The render prop that takes the injected remirror params and returns an
   * element to render. The editor view is automatically attached to the DOM.
   */
  children: RenderPropFunction<Combined>;
}

export class RenderEditor<Combined extends AnyCombinedUnion> extends PureComponent<
  RenderEditorProps<Combined>,
  RemirrorState<SchemaFromCombined<Combined>>
> {
  static defaultProps = defaultProps;

  /**
   * Sets a flag to be a static remirror
   */
  static $$remirrorType = RemirrorType.Editor;

  /**
   * This is needed to manage the controlled component `value` prop and copy it
   * to the components state for internal usage.
   */
  static getDerivedStateFromProps(
    properties: RenderEditorProps<DefaultReactCombined>,
    state: RemirrorState,
  ): RemirrorState | null {
    const { onStateChange, value } = properties;
    const {
      editor: { newState },
      ...rest
    } = state;

    if (onStateChange && value && value !== newState) {
      return {
        editor: { newState: value, oldState: newState },
        ...rest,
      };
    }

    return null;
  }

  /**
   * Stores the Prosemirror EditorView dom element.
   */
  private editorRef?: HTMLElement;

  /**
   * The prosemirror EditorView.
   */
  private readonly view: EditorViewType<SchemaFromCombined<Combined>>;

  /**
   * A unique ID for the editor which is also used as a key to pass into
   * `getRootProps`.
   */
  private readonly uid = uniqueId({ size: 10 });

  /**
   * The portal container which keeps track of all the React Portals containing
   * custom prosemirror NodeViews.
   */
  private readonly portalContainer: PortalContainer = new PortalContainer();

  /**
   * The document to use when rendering.
   */
  private get doc() {
    return getDocument(this.props.forceEnvironment);
  }

  /**
   * A utility for quickly retrieving the extension manager.
   */
  private get manager(): EditorManager<Combined> {
    return this.props.manager;
  }

  private rootPropsConfig = {
    called: false,
  };

  constructor(properties: RenderEditorProps<Combined>) {
    super(properties);

    // Ensure that children is a render prop.
    propIsFunction(properties.children);

    this.state = this.createInitialState();

    // Create the ProsemirrorView and initialize our extension manager with it.
    this.view = this.createView();
    this.manager.addView(this.view);
  }

  /**
   * Reinitialize the Editor's manager when a new one is passed in via props.
   *
   * TODO check whether or not the schema has changed and log a warning. Schema
   * shouldn't change.
   */
  updateManager() {
    // TODO add a way to reinitialize.
    this.manager.addView(this.view);
  }

  /**
   * Retrieve the editor state. This is passed through to the extension manager.
   */
  private readonly getState = () =>
    this.props.onStateChange && this.props.value ? this.props.value : this.view.state;

  /**
   * Create the initial React state which stores copies of the Prosemirror
   * editor state. Our React state also keeps track of the previous active
   * state.
   *
   * At this point both oldState and newState point to the same state object.
   */
  private createInitialState(): RemirrorState<SchemaFromCombined<Combined>> {
    const { suppressHydrationWarning } = this.props;

    const newState = this.createStateFromContent(this.props.initialContent);

    return {
      editor: {
        newState,
        oldState: newState,
      },
      shouldRenderClient: suppressHydrationWarning ? false : undefined,
    };
  }

  /**
   * Create the prosemirror editor view.
   */
  private createView() {
    return createEditorView<SchemaFromCombined<Combined>>(
      undefined,
      {
        state: this.state.editor.newState,
        nodeViews: this.manager.store.nodeViews,
        dispatchTransaction: this.dispatchTransaction,

        attributes: () => this.getAttributes(),
        editable: () => {
          return this.props.editable;
        },
      },
      this.props.forceEnvironment,
    );
  }

  /**
   * The external `getRootProps` that is used to spread props onto a desired
   * holder element for the prosemirror view.
   */
  private readonly getRootProps = <RefKey extends string = 'ref'>(
    options?: GetRootPropsConfig<RefKey>,
  ) => {
    return this.internalGetRootProps(options, null);
  };

  /**
   * Creates the props that should be spread on the root element inside which
   * the prosemirror instance will be rendered.
   */
  private readonly internalGetRootProps = <RefKey extends string = 'ref'>(
    options?: GetRootPropsConfig<RefKey>,
    children?: ReactNode,
  ): RefKeyRootProps<RefKey> => {
    // Ensure that this is the first time `getRootProps` is being called during
    // this render.
    invariant(!this.rootPropsConfig.called, { code: ErrorConstant.REACT_GET_ROOT_PROPS });
    this.rootPropsConfig.called = true;

    const { refKey: referenceKey = 'ref', ...config } =
      options ?? object<NonNullable<typeof options>>();

    return {
      [referenceKey]: this.onRef,
      key: this.uid,
      ...config,
      children: children ?? this.renderChildren(null),
    } as any;
  };

  /**
   * Stores the Prosemirror editor dom instance for this component using `refs`
   */
  private readonly onRef: Ref<HTMLElement> = (reference) => {
    if (reference) {
      this.editorRef = reference;
      this.onRefLoad();
    }
  };

  /**
   * This sets the attributes that wrap the outer prosemirror node.
   */
  private readonly getAttributes = (ssr = false) => {
    const { attributes, autoFocus } = this.props;
    const propertyAttributes = isFunction(attributes)
      ? attributes(this.eventListenerParameter())
      : attributes;

    const managerAttributes = this.manager.store?.attributes;

    const defaultAttributes = {
      role: 'textbox',
      autofocus: autoFocus ? 'true' : 'false',
      'aria-multiline': 'true',
      ...(!this.props.editable ? { 'aria-readonly': 'true' } : {}),
      'aria-label': this.props.label ?? '',
      ...managerAttributes,
      class: [ssr && 'Prosemirror', EDITOR_CLASS_NAME, managerAttributes?.class]
        .filter(bool)
        .join(' '),
    };

    return { ...defaultAttributes, ...propertyAttributes };
  };

  /**
   * Part of the Prosemirror API and is called whenever there is state change in
   * the editor.
   *
   * @internalremarks
   * How does it work when transactions are dispatched one after the other.
   */
  private readonly dispatchTransaction = (tr: Transaction) => {
    tr = this.props.onDispatchTransaction(tr, this.getState());
    const previousState = this.getState();
    const state = previousState.apply(tr);

    this.updateState({
      tr,
      state,
      onUpdate: () => {
        this.manager.onTransaction({ tr, state, previousState });
      },
    });
  };

  /**
   * This method manages state updates only when the `onStateChange` is passed
   * into the editor. Since it's up to the user to provide state updates to the
   * editor this method is called when the value prop has changed.
   */
  private readonly controlledUpdate = (state: EditorState<SchemaFromCombined<Combined>>) => {
    const updateHandler = this.createUpdateStateHandler({ state });
    this.view.updateState(state);
    updateHandler();
  };

  /**
   * Create the callback which is passed back to the setState handler.
   */
  private readonly createUpdateStateHandler = ({
    state,
    triggerOnChange,
    onUpdate,
    tr,
  }: UpdateStateParameter<SchemaFromCombined<Combined>>) => (updatedState = state) => {
    const { onChange } = this.props;

    // No need to continue if triggerOnChange is `false`
    if (!triggerOnChange) {
      return;
    }

    if (onUpdate) {
      onUpdate();
    }

    if (onChange) {
      onChange(this.eventListenerParameter({ state: updatedState, tr }));
    }
  };

  /**
   * Updates the state either by calling onStateChange when it exists or
   * directly setting the internal state via a `setState` call.
   */
  private updateState({
    state,
    triggerOnChange = true,
    onUpdate,
    tr,
  }: UpdateStateParameter<SchemaFromCombined<Combined>>) {
    const { onStateChange } = this.props;

    const updateHandler = this.createUpdateStateHandler({ state, triggerOnChange, onUpdate });

    // Check if this is a controlled component.
    if (onStateChange) {
      onStateChange(
        this.editorStateEventListenerParameter({
          oldState: this.state.editor.newState,
          newState: state,
          tr,
        }),
      );
    } else {
      // Update the internal prosemirror state. This happens before we update
      // the component's copy of the state.
      this.view.updateState(state);

      // This is not a controlled component so we need to manage firing of
      // setState
      this.setState(({ editor: { newState } }) => {
        return { editor: { oldState: newState, newState: state } };
        // Move update handler out from callback and directly after
        // this.setState To prevent updates from only happening with stale data.
      }, updateHandler);
    }
  }

  /**
   * Adds the prosemirror view to the dom in the position specified via the
   * component props.
   */
  private addProsemirrorViewToDom(reactReference: HTMLElement, viewDom: Element) {
    if (this.props.insertPosition === 'start') {
      reactReference.insertBefore(viewDom, reactReference.firstChild);
    } else {
      reactReference.append(viewDom);
    }
  }

  /**
   * Called once the container dom node (`this.editorRef`) has been initialized
   * after the component mounts.
   *
   * This method handles the cases where the dom is not focused.
   */
  private onRefLoad() {
    invariant(this.editorRef, {
      code: ErrorConstant.REACT_EDITOR_VIEW,
      message: 'Something went wrong when initializing the text editor. Please check your setup.',
    });

    const { autoFocus, onFirstRender, onStateChange } = this.props;
    this.addProsemirrorViewToDom(this.editorRef, this.view.dom);
    if (autoFocus) {
      this.focus(autoFocus);
    }

    if (onFirstRender) {
      onFirstRender(this.eventListenerParameter());
    }

    // Handle setting the state when this is a controlled component
    if (onStateChange) {
      onStateChange(this.editorStateEventListenerParameter());
    }

    this.view.dom.addEventListener('blur', this.onBlur);
    this.view.dom.addEventListener('focus', this.onFocus);
  }

  /**
   * This is purely used to indicate to the component that this is a client
   * environment when using the `suppressHydrationWarning` prop.
   */
  componentDidMount() {
    const { suppressHydrationWarning } = this.props;

    if (suppressHydrationWarning) {
      this.setState({ shouldRenderClient: true });
    }
  }

  componentDidUpdate(
    { editable, manager: previousManager }: RenderEditorProps<Combined>,
    previousState: RemirrorState<SchemaFromCombined<Combined>>,
  ) {
    // Ensure that children is still a render prop
    propIsFunction(this.props.children);

    // Check whether the editable prop has been updated
    if (this.props.editable !== editable && this.view && this.editorRef) {
      this.view.setProps({ ...this.view.props, editable: () => this.props.editable });
    }

    // Check if the manager has changed
    if (!previousManager.isEqual(this.props.manager)) {
      this.updateManager();
      this.view.setProps({ ...this.view.props, nodeViews: this.manager.store.nodeViews });

      // The following converts the current content to HTML and then uses the
      // new manager schema to convert it back into a ProsemirrorNode for
      // compatibility with the new manager.
      const htmlString = toHTML({
        node: this.state.editor.newState.doc,
        schema: previousManager.schema,
      });
      const newContent = fromHTML({
        schema: this.manager.schema,
        content: htmlString,
        doc: this.doc,
      });
      this.setContent(newContent, true);
    }

    const { newState } = this.state.editor;

    // Check if this is controlled component and run the post update handler
    if (this.props.onStateChange && newState !== previousState.editor.newState) {
      // The update was caused by an internal change
      this.controlledUpdate(newState);
    }
  }

  /**
   * Called when the component unmounts and is responsible for cleanup.
   *
   * @remarks
   *
   * - Removes listeners for the editor blur and focus events
   * - Destroys the state for each plugin
   * - Destroys the prosemirror view
   */
  componentWillUnmount() {
    this.view.dom.removeEventListener('blur', this.onBlur);
    this.view.dom.removeEventListener('focus', this.onFocus);
    const editorState = this.state.editor.newState;
    this.view.state.plugins.forEach((plugin) => {
      const state = plugin.getState(editorState);
      if (state?.destroy) {
        state.destroy();
      }
    });
    this.view.destroy();
  }

  /**
   * Listener for editor 'blur' events
   */
  private readonly onBlur = (event: Event) => {
    if (this.props.onBlur) {
      this.props.onBlur(this.eventListenerParameter(), event);
    }
  };

  /**
   * Listener for editor 'focus' events
   */
  private readonly onFocus = (event: Event) => {
    if (this.props.onFocus) {
      this.props.onFocus(this.eventListenerParameter(), event);
    }
  };

  /**
   * Sets the content of the editor.
   *
   * @param content
   * @param triggerOnChange
   */
  private readonly setContent = (content: RemirrorContentType, triggerOnChange = false) => {
    const state = this.createStateFromContent(content);
    this.updateState({ state, triggerOnChange });
  };

  /**
   * Clear; the content of the editor (reset to the default empty node)
   *
   * @param triggerOnChange - whether to notify the onChange handler that the
   * content has been reset
   */
  private readonly clearContent = (triggerOnChange = false) => {
    this.setContent(this.props.fallbackContent, triggerOnChange);
  };

  /**
   * The params used in the event listeners and the state listener
   */
  private baseListenerParameter({
    state,
    tr,
  }: ListenerParameter<Combined>): BaseListenerParameter<Combined> {
    return {
      tr,
      internalUpdate: !tr,
      view: this.view,
      getHTML: this.getHTML(state),
      getJSON: this.getJSON(state),
      getObjectNode: this.getObjectNode(state),
      getText: this.getText(state),
    };
  }

  /**
   * Creates the parameters passed into all event listener handlers.
   * e.g. `onChange`
   */
  private eventListenerParameter(
    { state, tr }: ListenerParameter<Combined> = object(),
  ): RemirrorEventListenerParameter<Combined> {
    return {
      ...this.baseListenerParameter({ tr }),
      state: state ?? this.state.editor.newState,
    };
  }

  /**
   * The params passed into onStateChange (within controlled components)
   */
  private editorStateEventListenerParameter(
    { newState, oldState, tr }: EditorStateEventListenerParameter<Combined> = object(),
  ): RemirrorStateListenerParameter<Combined> {
    return {
      ...this.baseListenerParameter({ state: newState, tr }),
      newState: newState ?? this.state.editor.newState,
      oldState: oldState ?? this.state.editor.oldState,
      createStateFromContent: this.createStateFromContent,
    };
  }

  /**
   * Set the focus for the editor.
   */
  private readonly focus = (position?: FocusType) => {
    if (position === false) {
      return;
    }

    if (this.view.hasFocus() && (position === undefined || position === true)) {
      return;
    }

    const { selection, doc, tr } = this.getState();
    const { from = 0, to = from } = selection;

    let pos: number | FromToParameter;

    /** Ensure the selection is within the current document range */
    const clampToDocument = (value: number) => clamp({ min: 0, max: doc.content.size, value });

    if (position === undefined || position === true) {
      pos = { from, to };
    } else if (position === 'start') {
      pos = 0;
    } else if (position === 'end') {
      pos = doc.nodeSize - 2;
    } else {
      pos = position;
    }

    let newSelection: TextSelection;

    if (isNumber(pos)) {
      pos = clampToDocument(pos);
      newSelection = TextSelection.near(doc.resolve(pos));
    } else {
      const start = clampToDocument(pos.from);
      const end = clampToDocument(pos.to);
      newSelection = TextSelection.create(doc, start, end);
    }

    // Set the selection to the requested value
    const transaction = tr.setSelection(newSelection);
    this.view.dispatch(transaction);

    // Wait for the next event loop to set the focus.
    requestAnimationFrame(() => this.view.focus());
  };

  get renderParameter(): RemirrorContextProps<Combined> {
    return {
      ...this.manager.store,

      /* Properties */
      uid: this.uid,
      manager: this.manager,
      view: this.view,
      state: this.state.editor,

      /* Getter Methods */
      getRootProps: this.getRootProps,

      /* Setter Methods */
      clearContent: this.clearContent,
      setContent: this.setContent,

      /* Helper Methods */
      focus: this.focus,

      portalContainer: this.portalContainer,
    };
  }

  private readonly getText = (state?: EditorState<SchemaFromCombined<Combined>>) => (
    lineBreakDivider = '\n\n',
  ) => {
    const { doc } = state ?? this.state.editor.newState;
    return doc.textBetween(0, doc.content.size, lineBreakDivider);
  };

  /**
   * Retrieve the HTML from the `doc` prosemirror node
   */
  private readonly getHTML = (state?: EditorState<SchemaFromCombined<Combined>>) => () => {
    return toHTML({
      node: (state ?? this.state.editor.newState).doc,
      schema: this.manager.store.schema,
      doc: this.doc,
    });
  };

  /**
   * Retrieve the full state json object
   */
  private readonly getJSON = (
    state?: EditorState<SchemaFromCombined<Combined>>,
  ) => (): ObjectNode => {
    return (state ?? this.state.editor.newState).toJSON() as ObjectNode;
  };

  /**
   * Return the json object for the prosemirror document.
   */
  private readonly getObjectNode = (
    state?: EditorState<SchemaFromCombined<Combined>>,
  ) => (): ObjectNode => {
    return (state ?? this.state.editor.newState).doc.toJSON() as ObjectNode;
  };

  /**
   * Create the editor state from a remirror content type.
   */
  private readonly createStateFromContent = (
    content: RemirrorContentType,
  ): EditorState<SchemaFromCombined<Combined>> => {
    const { stringHandler, fallbackContent: fallback } = this.props;
    return this.manager.createState({ content, doc: this.doc, stringHandler, onError: fallback });
  };

  /**
   * Checks whether this is an SSR environment and returns a child array with
   * the SSR component
   *
   * @param children
   */
  private renderChildren(child: ReactNode) {
    const { forceEnvironment, insertPosition, suppressHydrationWarning } = this.props;
    const { shouldRenderClient } = this.state;

    const children = isArray(child) ? child : [child];

    if (
      shouldUseDOMEnvironment(forceEnvironment) &&
      (!suppressHydrationWarning || shouldRenderClient)
    ) {
      return children;
    }

    const ssrElement = this.renderSSR();

    return (insertPosition === 'start' ? [ssrElement, ...children] : [...children, ssrElement]).map(
      addKeyToElement,
    );
  }

  /**
   * Return a JSX Element to be used within the domless environment.
   */
  private renderSSR() {
    return (
      <RemirrorSSR
        attributes={this.getAttributes(true)}
        state={this.state.editor.newState}
        manager={this.manager}
        editable={this.props.editable}
      />
    );
  }

  private renderReactElement() {
    const element: JSX.Element | null = this.props.children({
      ...this.renderParameter,
    });

    const { children, ...properties } = getElementProps(element);

    if (this.rootPropsConfig.called) {
      // Simply return the element as this method can never actually be called
      // within an ssr environment
      return element;
    } else if (
      // When called by a provider `getRootProps` can't actually be called until
      // the jsx is generated. Check if this is being rendered via any remirror
      // context provider. In this case `getRootProps` **must** be called by the
      // consumer.
      isRemirrorContextProvider(element) ||
      isRemirrorProvider(element)
    ) {
      const { childAsRoot } = element.props;
      return childAsRoot
        ? React.cloneElement(element, properties, this.renderClonedElement(children, childAsRoot))
        : element;
    } else {
      return isReactDOMElement(element) ? (
        this.renderClonedElement(element)
      ) : (
        <div {...this.internalGetRootProps(undefined, this.renderChildren(element))} />
      );
    }
  }

  /**
   * Clones the passed element when `getRootProps` hasn't yet been called.
   *
   * This method also supports rendering the children within a domless environment where necessary.
   */
  private renderClonedElement(
    element: JSX.Element,
    rootProperties?: GetRootPropsConfig<string> | boolean,
  ) {
    const { children, ...rest } = getElementProps(element);
    const properties = isPlainObject(rootProperties) ? { ...rootProperties, ...rest } : rest;

    return cloneElement(
      element,
      this.internalGetRootProps(properties, this.renderChildren(children)),
    );
  }

  render() {
    // Reset the status of roots props being called
    this.rootPropsConfig.called = false;

    return <Fragment>{this.renderReactElement()}</Fragment>;
  }
}
