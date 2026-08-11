import type { GoldenDataset } from './types';

/**
 * Why these two repositories specifically?
 *
 * klona (lukeed/klona): small, real, and already has a documented,
 * observed inferred-tier misclassification (spurious dbModel/
 * configuration nodes for a repository with no real database) from
 * Milestone 3a's own README. Question K6 below is a direct, targeted
 * probe of that exact known issue, not a hypothetical - the retrospective
 * explicitly recommended evaluating this gap "using the evaluation
 * harness," not by hand-tuning against the one known anecdote alone.
 *
 * shivangsatiya/Realtime-Chat-App: a real, substantial, already-imported
 * application with genuinely varied structure (routes, middleware,
 * validators, sockets, models). Every file name referenced below
 * (authRoutes.js, messageRoutes.js, socketHandler.js, etc.) was directly
 * observed in real, live screenshots during Milestone 3b's own browser
 * verification - not guessed or assumed from the repository's name.
 *
 * Why classify() was traced by hand for every question below, not
 * assumed:
 *
 * The classifier's real behavior (verified directly in
 * question-router.ts before writing this file) has real, non-obvious
 * edge cases - "why does this depend on Redis" checks explanatory
 * intent BEFORE the dependency keyword specifically because an earlier
 * version of this classifier got that wrong. Writing "expected"
 * categories from intuition rather than the actual regex would make
 * this dataset test the evaluator's assumptions, not the real system.
 *
 * A significant, worth-stating finding from that trace: `pure_semantic`
 * is a valid TypeScript type but is never actually produced by
 * classify() anywhere in the current implementation - every question
 * that doesn't match a dependency/cycle/path keyword falls through to
 * the same default as an explicit "why"/"explain" question: `hybrid`.
 * Questions below that are conceptually "pure semantic" (K6, K8, W9)
 * are labeled `expectedCategory: 'hybrid'` to match REAL system
 * behavior, not the conceptual category they'd occupy in an idealized
 * four-way split. This is reported explicitly in the evaluation
 * report's methodology section, not silently worked around.
 */
export const goldenDataset: GoldenDataset = {
  repositories: [
    {
      name: 'lukeed/klona',
      githubUrl: 'https://github.com/lukeed/klona',
      questions: [
        {
          id: 'K1',
          text: 'What does this package depend on?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'repository',
          criteria: 'Should list real outgoing dependency-analysis results (node IDs/labels), not prose.',
        },
        {
          id: 'K2',
          text: 'Does this codebase contain any circular dependencies?',
          expectedCategory: 'intelligence',
          criteria: 'Should return a real cycle-detection result. klona is a small utility; a genuinely correct answer likely reports zero cycles, though this must be checked against the actual result, not assumed.',
        },
        {
          id: 'K3',
          text: 'Why does this package need any dependencies at all?',
          expectedCategory: 'hybrid',
          expectedEntities: ['klona', 'clon'],
          criteria: 'A genuinely correct answer should note klona has few or no runtime dependencies, being a minimal deep-clone utility.',
        },
        {
          id: 'K4',
          text: 'Explain what this repository does.',
          expectedCategory: 'hybrid',
          expectedEntities: ['clon', 'deep'],
          criteria: 'Should correctly describe klona as a deep-cloning utility.',
        },
        {
          id: 'K5',
          text: 'What imports the main entry file?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'index',
          criteria: 'Should return real incoming dependency-analysis results, not prose.',
        },
        {
          id: 'K6',
          text: 'Does this repository use a database?',
          expectedCategory: 'hybrid',
          criteria: 'TARGETED PROBE for the known inferred-tier misclassification (spurious dbModel nodes observed live during Milestone 3a). A genuinely correct answer must say NO - klona is a pure utility library with no database. If the answer claims a database exists, that is a direct, reproducible confirmation of the known accuracy gap, not a new problem.',
        },
        {
          id: 'K7',
          text: 'What are all the transitive dependencies of this package?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'repository',
          criteria: 'Should return a transitive-mode dependency-analysis result specifically, not a direct-mode one.',
        },
        {
          id: 'K8',
          text: 'How does the cloning algorithm handle arrays versus objects?',
          expectedCategory: 'hybrid',
          expectedEntities: ['array', 'object'],
          criteria: 'Should reference real retrieved source content distinguishing array/object handling, not a generic non-specific answer.',
        },
        {
          id: 'K9',
          text: 'Who depends on the main index file?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'index',
          criteria: 'Should return real incoming dependency-analysis results.',
        },
        {
          id: 'K10',
          text: 'Is there a cyclic dependency between any modules in this repository?',
          expectedCategory: 'intelligence',
          criteria: 'Should return a real cycle-detection result.',
        },
      ],
    },
    {
      name: 'shivangsatiya/Realtime-Chat-App',
      githubUrl: 'https://github.com/shivangsatiya/Realtime-Chat-App.git',
      questions: [
        {
          id: 'W1',
          text: 'What does authRoutes.js depend on?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'authRoutes.js',
          criteria: 'Should return real outgoing dependency-analysis results for authRoutes.js specifically.',
        },
        {
          id: 'W2',
          text: 'Who depends on the auth.js middleware?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'auth.js',
          criteria: 'Should return real incoming dependency-analysis results for auth.js.',
        },
        {
          id: 'W3',
          text: 'Does this repository have any circular dependencies?',
          expectedCategory: 'intelligence',
          criteria: 'Should return a real cycle-detection result for the actual imported graph.',
        },
        {
          id: 'W4',
          text: 'Why does messageRoutes.js depend on messageValidators.js?',
          expectedCategory: 'hybrid',
          expectedEntities: ['validat', 'message'],
          criteria: 'Should give a real explanation referencing message validation, not a generic non-answer.',
        },
        {
          id: 'W5',
          text: 'Explain what the socketHandler.js file does.',
          expectedCategory: 'hybrid',
          expectedEntities: ['socket'],
          criteria: 'Should correctly describe real-time socket/message handling behavior.',
        },
        {
          id: 'W6',
          text: 'What imports the User.js model?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'User.js',
          criteria: 'Should return real incoming dependency-analysis results for User.js.',
        },
        {
          id: 'W7',
          text: 'How does the authentication middleware work?',
          expectedCategory: 'hybrid',
          expectedEntities: ['auth', 'token'],
          criteria: 'Should reference real retrieved content about the auth middleware, not a generic description.',
        },
        {
          id: 'W8',
          text: 'What are the transitive dependencies of messageRoutes.js?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'messageRoutes.js',
          criteria: 'Should return a transitive-mode dependency-analysis result specifically.',
        },
        {
          id: 'W9',
          text: 'Where is rate limiting implemented in this codebase?',
          expectedCategory: 'hybrid',
          expectedEntities: ['rateLimit', 'limit'],
          criteria: 'A genuinely correct answer should reference rateLimiters.js specifically.',
        },
        {
          id: 'W10',
          text: 'Explain how error handling works in this application.',
          expectedCategory: 'hybrid',
          expectedEntities: ['error', 'asyncHandler'],
          criteria: 'A genuinely correct answer should reference asyncHandler.js and/or ValidationError.js.',
        },
        {
          id: 'W11',
          text: 'Does Conversation.js import Message.js?',
          expectedCategory: 'pure_graph',
          nodeLabelHint: 'Conversation.js',
          criteria: 'Should return a real dependency-analysis result for Conversation.js, direction unspecified.',
        },
        {
          id: 'W12',
          text: 'Is there a cycle between conversationRoutes.js and its dependencies?',
          expectedCategory: 'intelligence',
          criteria: 'Should return a real cycle-detection result.',
        },
      ],
    },
  ],
};
