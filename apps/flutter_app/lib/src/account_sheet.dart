import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'app_strings.dart';
import 'app_errors.dart';
import 'drama_repository.dart';

Future<bool> showAccountSheet(
  BuildContext context,
  AppController controller, {
  String? reason,
}) async =>
    await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => AccountSheet(controller: controller, reason: reason),
    ) ==
    true;

class AccountSheet extends StatefulWidget {
  const AccountSheet({super.key, required this.controller, this.reason});
  final AppController controller;
  final String? reason;
  @override
  State<AccountSheet> createState() => _AccountSheetState();
}

class _AccountSheetState extends State<AccountSheet> {
  final email = TextEditingController();
  final password = TextEditingController();
  final username = TextEditingController();
  final code = TextEditingController();
  String mode = 'login';
  String? error;
  String? challengeId;
  String? verificationToken;
  bool busy = false;
  bool accepted = false;
  bool identityTerms = false;
  List<Map<String, dynamic>> documents = [];
  int cooldown = 0;
  Timer? timer;
  DramaRepository get repository => widget.controller.repository;
  String get purpose => mode == 'register' ? 'verify_email' : 'password_reset';

  @override
  void initState() {
    super.initState();
    if (repository.demoMode) {
      email.text = 'demo@nightflix.test';
      password.text = 'Demo-only-password';
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    email.dispose();
    password.dispose();
    username.dispose();
    code.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() operation) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await operation();
    } catch (cause) {
      if (mounted) setState(() => error = friendlyError(context, cause));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void _changeMode(String value) {
    setState(() {
      mode = value;
      challengeId = null;
      verificationToken = null;
      accepted = false;
      identityTerms = false;
      code.clear();
      error = null;
      documents = [];
    });
    if (value == 'register') {
      _run(() async {
        final loaded = await repository.legalDocuments(
          widget.controller.locale,
        );
        if (mounted) setState(() => documents = loaded);
      });
    }
  }

  Future<void> _sendCode() => _run(() async {
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email.text.trim())) {
      throw ApiException(
        context.tr('invalidEmail', 'Enter a valid email address'),
        400,
      );
    }
    challengeId = await repository.requestEmailCode(email.text, purpose);
    verificationToken = null;
    if (!mounted) return;
    setState(() => cooldown = 60);
    timer?.cancel();
    timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() => cooldown--);
      if (cooldown <= 0) timer.cancel();
    });
  });

  Future<void> _submit() => _run(() async {
    if (mode != 'login') {
      if (password.text.length < 8) {
        throw ApiException(
          context.tr('passwordLength', 'Use at least 8 characters'),
          400,
        );
      }
      if (challengeId == null) {
        throw ApiException(
          context.tr('requestCode', 'Request an email code first'),
          400,
        );
      }
      if (mode == 'register' &&
          (!accepted ||
              !documents.any((d) => d['documentType'] == 'privacy') ||
              !documents.any((d) => d['documentType'] == 'terms'))) {
        throw ApiException(
          context.tr(
            'acceptTerms',
            'Read and accept the terms and privacy policy',
          ),
          400,
        );
      }
      verificationToken ??= await repository.verifyEmailCode(
        email.text,
        purpose,
        challengeId!,
        code.text,
      );
      if (mode == 'register') {
        await repository.registerEmail(
          email: email.text,
          username: username.text,
          password: password.text,
          verificationToken: verificationToken!,
          locale: widget.controller.locale,
          consents: documents
              .where(
                (d) =>
                    d['requiredForRegistration'] == true ||
                    d['documentType'] == 'privacy' ||
                    d['documentType'] == 'terms',
              )
              .map(
                (d) => <String, dynamic>{
                  'documentId': d['id'],
                  'version': d['version'],
                },
              )
              .toList(),
        );
      } else {
        await repository.resetPassword(
          email.text,
          password.text,
          verificationToken!,
        );
      }
      // If the subsequent login fails, retry login rather than reusing a consumed OTP grant.
      if (mounted) setState(() => mode = 'login');
    }
    await widget.controller.login(email.text, password.text);
    if (mounted) Navigator.pop(context, true);
  });

  Future<void> _identityLogin(String provider) => _run(() async {
    if (!identityTerms || documents.isEmpty) {
      final loaded = await repository.legalDocuments(widget.controller.locale);
      if (!mounted) return;
      setState(() {
        documents = loaded;
        identityTerms = true;
        accepted = false;
      });
      return;
    }
    if (!accepted) {
      throw ApiException(
        context.tr(
          'acceptTerms',
          'Read and accept the terms and privacy policy',
        ),
        400,
      );
    }
    await repository.identityLogin(
      provider,
      widget.controller.config,
      widget.controller.locale,
      documents
          .map(
            (d) => <String, dynamic>{
              'documentId': d['id'],
              'version': d['version'],
            },
          )
          .toList(),
    );
    if (mounted) Navigator.pop(context, true);
  });

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    child: Padding(
      padding: EdgeInsets.fromLTRB(
        22,
        18,
        22,
        MediaQuery.viewInsetsOf(context).bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            mode == 'login'
                ? widget.reason ?? context.tr('welcomeBack', 'Welcome back')
                : mode == 'register'
                ? context.tr('createAccount', 'Create account')
                : context.tr('resetPassword', 'Reset password'),
            style: const TextStyle(fontSize: 23, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 8),
          Text(
            context.tr(
              'accountHint',
              'Your purchases, favorites and history stay with you.',
            ),
            style: const TextStyle(color: Colors.white60),
          ),
          const SizedBox(height: 18),
          TextField(
            controller: email,
            enabled: !busy && challengeId == null,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            decoration: InputDecoration(
              labelText: context.tr('email', 'Email'),
            ),
          ),
          if (mode == 'register') ...[
            const SizedBox(height: 12),
            TextField(
              controller: username,
              enabled: !busy,
              autocorrect: false,
              decoration: InputDecoration(
                labelText: context.tr('username', 'Username'),
              ),
            ),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: password,
            enabled: !busy,
            obscureText: true,
            autofillHints: [
              mode == 'login'
                  ? AutofillHints.password
                  : AutofillHints.newPassword,
            ],
            decoration: InputDecoration(
              labelText: context.tr('password', 'Password'),
            ),
          ),
          if (mode != 'login') ...[
            const SizedBox(height: 12),
            TextField(
              controller: code,
              enabled: !busy,
              keyboardType: TextInputType.number,
              autofillHints: const [AutofillHints.oneTimeCode],
              onChanged: (_) => verificationToken = null,
              decoration: InputDecoration(
                labelText: context.tr('verificationCode', 'Verification code'),
                suffixIcon: TextButton(
                  onPressed: busy || cooldown > 0 ? null : _sendCode,
                  child: Text(
                    cooldown > 0
                        ? '$cooldown s'
                        : context.tr('sendCode', 'Send code'),
                  ),
                ),
              ),
            ),
          ],
          if (mode == 'register' || identityTerms) ...[
            ...documents.map(
              (d) => TextButton(
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (dialogContext) => AlertDialog(
                    title: Text(d['title'] as String),
                    content: SingleChildScrollView(
                      child: SelectableText(d['bodyMarkdown'] as String),
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.pop(dialogContext),
                        child: Text(context.tr('close', 'Close')),
                      ),
                    ],
                  ),
                ),
                child: Text(d['title'] as String),
              ),
            ),
            CheckboxListTile(
              value: accepted,
              contentPadding: EdgeInsets.zero,
              onChanged: busy
                  ? null
                  : (v) => setState(() => accepted = v ?? false),
              title: Text(
                context.tr(
                  'acceptTerms',
                  'Read and accept the terms and privacy policy',
                ),
              ),
            ),
          ],
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                error!,
                style: const TextStyle(color: Colors.redAccent),
              ),
            ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: busy ? null : _submit,
            child: busy
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(
                    mode == 'login'
                        ? context.tr('continueEmail', 'Continue with email')
                        : mode == 'register'
                        ? context.tr('createAccount', 'Create account')
                        : context.tr('resetPassword', 'Reset password'),
                  ),
          ),
          if (!repository.demoMode && mode == 'login') ...[
            if (widget.controller.config.capabilities['googleSignIn'] == true)
              OutlinedButton(
                onPressed: busy ? null : () => _identityLogin('google'),
                child: const Text('Google'),
              ),
            if (Platform.isIOS &&
                widget.controller.config.capabilities['appleSignIn'] == true)
              OutlinedButton(
                onPressed: busy ? null : () => _identityLogin('apple'),
                child: const Text('Apple'),
              ),
          ],
          if (!repository.demoMode)
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                TextButton(
                  onPressed: busy
                      ? null
                      : () =>
                            _changeMode(mode == 'login' ? 'register' : 'login'),
                  child: Text(
                    mode == 'login'
                        ? context.tr('createAccount', 'Create account')
                        : context.tr('signIn', 'Sign in'),
                  ),
                ),
                if (mode == 'login')
                  TextButton(
                    onPressed: busy ? null : () => _changeMode('reset'),
                    child: Text(
                      context.tr('forgotPassword', 'Forgot password?'),
                    ),
                  ),
              ],
            ),
        ],
      ),
    ),
  );
}
