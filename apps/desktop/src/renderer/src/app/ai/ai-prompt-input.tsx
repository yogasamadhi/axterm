import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AtSign, Send, X } from 'lucide-react';
import type { AiSkill } from '@workspace/contracts';
import { useI18n } from '../../i18n/context';
import {
  aiSkillLabels,
  aiSkillMention,
  removeAiSkillMention,
  type SkillMention,
} from './ai-skills';

export function AiPromptInput({
  prompt,
  skills,
  selectedSkill,
  disabled,
  sendDisabled,
  onPromptChange,
  onSkillChange,
}: {
  prompt: string;
  skills: AiSkill[];
  selectedSkill: AiSkill | undefined;
  disabled: boolean;
  sendDisabled: boolean;
  onPromptChange(value: string): void;
  onSkillChange(skill: AiSkill | undefined): void;
}) {
  const { x } = useI18n();
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const nextCaret = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (nextCaret.current === undefined) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = undefined;
  }, [prompt]);
  const [mention, setMention] = useState<SkillMention>();
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState({ left: 8, width: 200, bottom: 8, maxHeight: 190 });
  useLayoutEffect(() => {
    if (!mention) return;
    const measure = () => {
      const box = input.current?.getBoundingClientRect();
      if (!box) return;
      const above = Math.max(0, box.top - 14);
      const below = Math.max(0, innerHeight - box.bottom - 14);
      const placeAbove = above >= Math.min(190, below);
      const width = Math.min(box.width, Math.max(40, innerWidth - 16));
      const maxHeight = Math.max(40, Math.min(190, placeAbove ? above : below));
      const next = {
        left: Math.max(8, Math.min(box.left, innerWidth - width - 8)),
        width,
        maxHeight,
        bottom: placeAbove
          ? innerHeight - box.top + 6
          : Math.max(8, innerHeight - box.bottom - 6 - maxHeight),
      };
      setPosition((current) =>
        Object.keys(next).every(
          (key) => current[key as keyof typeof next] === next[key as keyof typeof next],
        )
          ? current
          : next,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [mention]);
  const filtered = skills.filter((skill) =>
    `${skill.id} ${x(aiSkillLabels[skill.useCase])}`
      .toLowerCase()
      .includes(mention?.query.toLowerCase() ?? ''),
  );
  const active = Math.min(index, Math.max(0, filtered.length - 1));
  function choose(skill: AiSkill) {
    if (!mention) return;
    const nextPrompt = removeAiSkillMention(prompt, mention);
    nextCaret.current = nextPrompt === prompt ? undefined : mention.start;
    onPromptChange(nextPrompt);
    onSkillChange(skill);
    input.current?.focus();
    input.current?.setSelectionRange(mention.start, mention.start);
    setMention(undefined);
  }
  return (
    <div className="ai-prompt-input">
      <div className="ai-skill-toolbar">
        <button
          type="button"
          disabled={disabled || !skills.length}
          onClick={() => {
            const caret = input.current?.selectionStart ?? prompt.length;
            setMention(aiSkillMention(prompt, caret) ?? { start: caret, end: caret, query: '' });
            setIndex(0);
            input.current?.focus();
          }}
        >
          <AtSign size={12} /> {x('ai.skills')}
        </button>
        {selectedSkill && (
          <span className="ai-selected-skill">
            <AtSign size={11} /> {x(aiSkillLabels[selectedSkill.useCase])}
            <button
              type="button"
              aria-label={x('ai.removeSkill')}
              onClick={() => onSkillChange(undefined)}
            >
              <X size={11} />
            </button>
          </span>
        )}
      </div>
      <label className="ai-chat-prompt">
        <span className="sr-only">{x('panels.question')}</span>
        <textarea
          ref={input}
          name="prompt"
          disabled={disabled}
          rows={3}
          maxLength={16_384}
          value={prompt}
          placeholder={x('ai.promptWithSkills')}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={mention ? id : undefined}
          aria-activedescendant={
            mention && filtered[active] ? `${id}-${filtered[active]!.id}` : undefined
          }
          onChange={(event) => {
            onPromptChange(event.currentTarget.value);
            setMention(
              (event.nativeEvent as InputEvent).isComposing
                ? undefined
                : aiSkillMention(event.currentTarget.value, event.currentTarget.selectionStart),
            );
            setIndex(0);
          }}
          onBlur={() => setMention(undefined)}
          onCompositionStart={() => setMention(undefined)}
          onCompositionEnd={(event) => {
            setMention(
              aiSkillMention(event.currentTarget.value, event.currentTarget.selectionStart),
            );
            setIndex(0);
          }}
          onKeyUp={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              setMention(
                aiSkillMention(event.currentTarget.value, event.currentTarget.selectionStart),
              );
              setIndex(0);
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (mention) {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setMention(undefined);
                return;
              }
              if (['ArrowDown', 'ArrowUp'].includes(event.key) && filtered.length) {
                event.preventDefault();
                setIndex(
                  (active + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) %
                    filtered.length,
                );
                return;
              }
              if (
                (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) &&
                filtered[active]
              ) {
                event.preventDefault();
                choose(filtered[active]!);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              setMention(undefined);
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          type="submit"
          className="primary ai-chat-send"
          disabled={sendDisabled}
          aria-label={x('ai.send')}
          title={x('ai.send')}
        >
          <Send size={15} />
        </button>
      </label>
      {mention &&
        createPortal(
          <div
            className="ai-skill-picker"
            style={position}
            role="listbox"
            id={id}
            aria-label={x('ai.skills')}
          >
            {filtered.map((skill, itemIndex) => (
              <button
                type="button"
                role="option"
                id={`${id}-${skill.id}`}
                aria-selected={itemIndex === active}
                key={skill.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(skill)}
              >
                <strong>{x(aiSkillLabels[skill.useCase])}</strong>
                <small>@{skill.id}</small>
              </button>
            ))}
            {!filtered.length && <span>{x('ai.noMatchingSkills')}</span>}
          </div>,
          document.body,
        )}
    </div>
  );
}
