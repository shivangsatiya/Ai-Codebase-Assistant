const SUGGESTIONS_BY_TYPE: Record<string, string[]> = {
  service: ['Why does this service depend on Redis?', 'Who calls this service?', "Explain this service's responsibilities."],
  controller: ['Who calls this controller?', 'Which services does this rely on?', 'Explain what this controller does.'],
  route: [
    'What happens when this endpoint is called?',
    'Which service handles this route?',
    'Which database tables does this endpoint touch?',
  ],
  dbModel: ['Which services depend on this database?', 'Which APIs write to this database?'],
  package: ['Where is this package used?', 'Why is this dependency required?'],
  class: ['Explain what this class does.', 'Who depends on this class?', 'What does this class depend on?'],
  function: ['Explain what this function does.', 'Who calls this function?'],
  method: ['Explain what this method does.', 'Who calls this method?'],
};

const DEFAULT_SUGGESTIONS = ['Explain this component.', 'What does this depend on?', 'What depends on this?'];

export function suggestedQuestionsFor(nodeType: string): string[] {
  return SUGGESTIONS_BY_TYPE[nodeType] ?? DEFAULT_SUGGESTIONS;
}
