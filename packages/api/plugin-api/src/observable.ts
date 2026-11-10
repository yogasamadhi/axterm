/** Canonical framework-neutral observable shared by Client models and browser infrastructure. */
export interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
