import 'package:flutter/widgets.dart';

import 'app_strings.dart';
import 'drama_repository.dart';

// Never display raw server/provider errors or stack traces in the customer UI.
String friendlyError(BuildContext context, Object error) {
  if (error is ApiException) {
    if (error.statusCode == 401) {
      return context.tr('sessionExpired', 'Please sign in again.');
    }
    if (error.statusCode == 403 || error.statusCode == 404) {
      return context.tr('contentUnavailable', 'This content is unavailable.');
    }
    if (error.statusCode == 400) {
      return context.tr('checkInput', 'Please check your information.');
    }
    if (error.statusCode == 409) {
      return context.tr(
        'requestConflict',
        'The state has changed. Refresh and try again.',
      );
    }
    if (error.statusCode == 429) {
      return context.tr(
        'tooManyRequests',
        'Please wait a moment and try again.',
      );
    }
  }
  return context.tr(
    'requestFailed',
    'Unable to complete this request. Please try again.',
  );
}
