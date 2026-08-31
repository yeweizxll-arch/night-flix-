import type { ContentLocale } from './api/types';

const en = {
  account: 'Account', accountName: 'Username', accountSummary: 'Account summary', all: 'All', autoPlay: 'Auto-play',
  amount: 'Amount', buyDrama: 'Buy full drama', buyEpisode: 'Buy this episode', checkPrice: 'Check price',
  checkoutUnavailable: 'Checkout is unavailable. No alternate payment route was used.', currency: 'Currency',
  codePrepared: 'The verification request is ready. Use the code provided by the site operator.', codeSent: 'Verification code sent', confirmPassword: 'Confirm password', consentHistory: 'Consent history', contactVerified: 'Contact verified', currentPassword: 'Current password', dataSection: 'Data section', downloadData: 'Download my data', downloadJson: 'Download JSON',
  back: 'Back', categories: 'Categories', completed: 'Completed', continueWatching: 'Continue watching',
  details: 'Details', devices: 'Devices', empty: 'Nothing here yet', episode: 'Episode', episodes: 'Episodes',
  error: 'Something went wrong', favorite: 'Favorite', favorites: 'Favorites', fullScreen: 'Full screen',
  history: 'History', home: 'Home', internal: 'Internal test · not a public release', language: 'Language',
  erasureProcessingNotice: 'Your request is processing. Identifiers will be removed while legally required records remain for their retention period.', erasureSubmitted: 'Erasure request submitted', erasureWarning: 'Submitting immediately signs this account out. Some financial and security records remain de-identified for legal retention.', exportNotice: 'The password is used only for this export and is cleared immediately.',
  latest: 'Latest', loading: 'Loading…', locked: 'This episode is locked.',
  login: 'Sign in', loginHint: 'Password sign-in only. This browser tab does not remember your login.',
  legalConsents: 'Legal consents', legalDocuments: 'Legal documents', legalUnavailable: 'Current privacy policy and terms are unavailable, so registration is blocked.',
  logout: 'Sign out', next: 'Next', noRemember: 'No “remember me”: closing this tab clears the refresh session.',
  orderNumber: 'Order', password: 'Password', payWithStripe: 'Continue to Stripe',
  passwordMismatch: 'Passwords do not match.', phone: 'Phone number', privacyCenter: 'Privacy center', privacyOperationFailed: 'The privacy operation failed safely. Please retry.',
  paymentCancelled: 'Checkout cancelled', paymentChecking: 'Confirming payment', paymentCheckError: 'Could not refresh the order status.',
  paymentFailed: 'Payment was not completed.', paymentPaid: 'Payment confirmed', paymentSignIn: 'Sign in before starting checkout.',
  paymentUnavailable: 'Payments are not available for this site.', priceChanged: 'The server price changed. Review it and confirm again.',
  readDocument: 'Read', redirecting: 'Opening Stripe…', register: 'Create account', registrationComplete: 'Account created', registrationFailed: 'Registration failed. Contact verification or legal versions may have expired.', registrationLoginNext: 'Sign in with the new account to continue.', required: 'Required', requestErasure: 'Request account erasure', retentionAcknowledgement: 'I understand that legally required de-identified records remain until their retention dates.', sendCode: 'Send verification code', serverPriceNotice: 'The amount comes from the server. This page cannot edit it.', sessionIdIgnored: 'Return parameters do not confirm payment; only the server order status is trusted.', status: 'Status', stripeHosted: 'Secure hosted checkout; no card data is collected here.', submitErasure: 'Submit erasure request',
  play: 'Play', previewUnavailable: 'This episode does not have a preview.',
  previous: 'Previous', refresh: 'Retry', registrationUnavailable: 'Registration is temporarily unavailable for this site.',
  removeFavorite: 'Remove favorite', resumeAt: 'Resume at', revoke: 'Sign out device', search: 'Search titles or descriptions',
  searchButton: 'Search', signInRequired: 'Sign in to use this feature.', speed: 'Speed', tags: 'Tags',
  thirdPartyFollowUp: 'Third-party processor follow-up is tracked separately; this request does not claim immediate third-party deletion.', typeDelete: 'Type DELETE to confirm', username: 'Username, email, or phone', verificationCode: 'Verification code', verified: 'Verified', verify: 'Verify code', verifyContact: 'Verify email or phone', watch: 'Watch', webhookPending: 'Stripe confirmation may take a moment. This page will refresh safely.',
} as const;

type MessageKey = keyof typeof en;

const privacyMessages = {
  'zh-CN': {
    accountName: '用户名',
    codePrepared: '验证请求已准备，请使用站点运营方提供的验证码。', codeSent: '验证码已发送', confirmPassword: '确认密码', consentHistory: '同意记录', contactVerified: '联系方式已验证', currentPassword: '当前密码', dataSection: '数据分类', downloadData: '下载我的数据', downloadJson: '下载 JSON',
    erasureProcessingNotice: '申请处理中。身份标识将被去除，法定记录会在保留期内去标识保留。', erasureSubmitted: '擦除申请已提交', erasureWarning: '提交后会立即退出此账号；部分财务和安全记录需去标识保留。', exportNotice: '密码仅用于本次导出，操作后立即清空。',
    legalConsents: '法律条款同意', legalDocuments: '法律文档', legalUnavailable: '当前隐私政策或服务条款不可用，暂时无法注册。',
    locked: '本集尚未获得观看权限。', passwordMismatch: '两次密码不一致。', paymentUnavailable: '当前站点暂不可用支付。', phone: '手机号', previewUnavailable: '本集未配置试看内容。', privacyCenter: '隐私中心', privacyOperationFailed: '隐私操作未完成，请安全重试。',
    readDocument: '阅读', register: '注册账号', registrationComplete: '账号已创建', registrationFailed: '注册失败，验证或条款版本可能已过期。', registrationLoginNext: '请使用新账号登录。', registrationUnavailable: '当前站点暂不可注册。', required: '必须同意', requestErasure: '申请账号擦除', retentionAcknowledgement: '我理解法定要求的记录将去标识保留至到期日。', sendCode: '发送验证码', submitErasure: '提交擦除申请',
    thirdPartyFollowUp: '第三方处理需另行跟进，本申请不声称第三方已立即删除。', typeDelete: '输入 DELETE 确认', verificationCode: '验证码', verify: '验证', verifyContact: '验证邮箱或手机号',
  },
  'zh-TW': {
    accountName: '使用者名稱',
    codePrepared: '驗證請求已準備，請使用網站營運方提供的驗證碼。', codeSent: '驗證碼已傳送', confirmPassword: '確認密碼', consentHistory: '同意紀錄', contactVerified: '聯絡方式已驗證', currentPassword: '目前密碼', dataSection: '資料分類', downloadData: '下載我的資料', downloadJson: '下載 JSON',
    erasureProcessingNotice: '申請處理中。身分標識將移除，法定紀錄將在保留期內去標識保留。', erasureSubmitted: '擦除申請已送出', erasureWarning: '送出後會立即登出；部分財務與安全紀錄需去標識保留。', exportNotice: '密碼僅用於本次匯出，完成後立即清除。',
    legalConsents: '法律條款同意', legalDocuments: '法律文件', legalUnavailable: '目前隱私政策或服務條款不可用，暫時無法註冊。',
    locked: '本集尚未取得觀看權限。', passwordMismatch: '兩次密碼不一致。', paymentUnavailable: '目前網站暫不可使用付款。', phone: '手機號碼', previewUnavailable: '本集未設定試看內容。', privacyCenter: '隱私中心', privacyOperationFailed: '隱私操作未完成，請安全重試。',
    readDocument: '閱讀', register: '註冊帳戶', registrationComplete: '帳戶已建立', registrationFailed: '註冊失敗，驗證或條款版本可能已過期。', registrationLoginNext: '請使用新帳戶登入。', registrationUnavailable: '目前網站暫不可註冊。', required: '必須同意', requestErasure: '申請帳戶擦除', retentionAcknowledgement: '我理解法定要求的紀錄將去標識保留至到期日。', sendCode: '傳送驗證碼', submitErasure: '送出擦除申請',
    thirdPartyFollowUp: '第三方處理需另行追蹤，本申請不聲稱第三方已立即刪除。', typeDelete: '輸入 DELETE 確認', verificationCode: '驗證碼', verify: '驗證', verifyContact: '驗證電郵或手機號碼',
  },
  'fr-FR': {
    accountName: 'Nom d’utilisateur',
    codePrepared: "La demande est prête. Utilisez le code fourni par l’opérateur du site.", codeSent: 'Code envoyé', confirmPassword: 'Confirmer le mot de passe', consentHistory: 'Historique des consentements', contactVerified: 'Contact vérifié', currentPassword: 'Mot de passe actuel', dataSection: 'Catégorie de données', downloadData: 'Télécharger mes données', downloadJson: 'Télécharger JSON',
    erasureProcessingNotice: 'Demande en cours. Les identifiants seront retirés et les registres légaux conservés sous forme dépersonnalisée.', erasureSubmitted: "Demande d’effacement envoyée", erasureWarning: 'La demande déconnecte immédiatement ce compte. Certains registres financiers et de sécurité restent dépersonnalisés.', exportNotice: 'Le mot de passe sert uniquement à cet export puis est effacé.',
    legalConsents: 'Consentements juridiques', legalDocuments: 'Documents juridiques', legalUnavailable: "La politique de confidentialité ou les conditions actuelles manquent ; l’inscription est bloquée.",
    locked: 'Cet épisode est verrouillé.', passwordMismatch: 'Les mots de passe diffèrent.', paymentUnavailable: 'Le paiement est indisponible pour ce site.', phone: 'Téléphone', previewUnavailable: "Cet épisode n’a pas d’aperçu.", privacyCenter: 'Centre de confidentialité', privacyOperationFailed: "L’opération a échoué en toute sécurité. Réessayez.",
    readDocument: 'Lire', register: 'Créer un compte', registrationComplete: 'Compte créé', registrationFailed: "Échec de l’inscription ; la vérification ou les versions juridiques ont pu expirer.", registrationLoginNext: 'Connectez-vous avec le nouveau compte.', registrationUnavailable: "L’inscription est temporairement indisponible pour ce site.", required: 'Obligatoire', requestErasure: "Demander l’effacement", retentionAcknowledgement: 'Je comprends que les registres légaux dépersonnalisés restent jusqu’à leur échéance.', sendCode: 'Envoyer le code', submitErasure: 'Envoyer la demande',
    thirdPartyFollowUp: "Le suivi des sous-traitants est séparé ; aucun effacement tiers immédiat n’est affirmé.", typeDelete: 'Saisissez DELETE', verificationCode: 'Code de vérification', verify: 'Vérifier', verifyContact: 'Vérifier e-mail ou téléphone',
  },
  'ja-JP': {
    accountName: 'ユーザー名',
    codePrepared: '認証リクエストの準備ができました。サイト運営者から提供されたコードを使用してください。', codeSent: '認証コード送信済み', confirmPassword: 'パスワード確認', consentHistory: '同意履歴', contactVerified: '連絡先確認済み', currentPassword: '現在のパスワード', dataSection: 'データ区分', downloadData: 'データをダウンロード', downloadJson: 'JSON をダウンロード',
    erasureProcessingNotice: '申請を処理中です。識別子を削除し、法定記録は匿名化して保持期間保管します。', erasureSubmitted: '消去申請送信済み', erasureWarning: '送信後すぐにログアウトします。一部の財務・セキュリティ記録は匿名化保管されます。', exportNotice: 'パスワードはこの出力のみに使用し、直後に消去します。',
    legalConsents: '法的同意', legalDocuments: '法律文書', legalUnavailable: '現在のプライバシーポリシーまたは利用規約がないため登録できません。',
    locked: 'この話はロックされています。', passwordMismatch: 'パスワードが一致しません。', paymentUnavailable: 'このサイトでは現在決済を利用できません。', phone: '電話番号', previewUnavailable: 'この話にはプレビューがありません。', privacyCenter: 'プライバシーセンター', privacyOperationFailed: 'プライバシー操作は完了しませんでした。再試行してください。',
    readDocument: '読む', register: 'アカウント作成', registrationComplete: 'アカウント作成完了', registrationFailed: '登録に失敗しました。認証または文書版が期限切れの可能性があります。', registrationLoginNext: '新しいアカウントでログインしてください。', registrationUnavailable: 'このサイトでは現在登録できません。', required: '必須', requestErasure: 'アカウント消去を申請', retentionAcknowledgement: '法定記録が匿名化され保持期限まで残ることを理解します。', sendCode: '認証コードを送信', submitErasure: '消去申請を送信',
    thirdPartyFollowUp: '外部処理者の対応は別途追跡され、即時削除済みとは表示しません。', typeDelete: 'DELETE と入力', verificationCode: '認証コード', verify: '確認', verifyContact: 'メールまたは電話を確認',
  },
  'ko-KR': {
    accountName: '사용자명',
    codePrepared: '인증 요청이 준비되었습니다. 사이트 운영자가 제공한 코드를 사용하세요.', codeSent: '인증 코드 전송 완료', confirmPassword: '비밀번호 확인', consentHistory: '동의 기록', contactVerified: '연락처 인증 완료', currentPassword: '현재 비밀번호', dataSection: '데이터 항목', downloadData: '내 데이터 다운로드', downloadJson: 'JSON 다운로드',
    erasureProcessingNotice: '요청 처리 중입니다. 식별자는 제거되고 법적 기록은 비식별 상태로 보존 기간 동안 유지됩니다.', erasureSubmitted: '삭제 요청 제출 완료', erasureWarning: '제출 즉시 로그아웃됩니다. 일부 재무/보안 기록은 비식별 보존됩니다.', exportNotice: '비밀번호는 이 내보내기에만 사용하고 즉시 지웁니다.',
    legalConsents: '법적 동의', legalDocuments: '법적 문서', legalUnavailable: '현재 개인정보 처리방침 또는 약관이 없어 가입할 수 없습니다.',
    locked: '이 회차는 잠겨 있습니다.', passwordMismatch: '비밀번호가 일치하지 않습니다.', paymentUnavailable: '현재 사이트에서 결제를 사용할 수 없습니다.', phone: '휴대전화', previewUnavailable: '이 회차에는 미리보기가 없습니다.', privacyCenter: '개인정보 센터', privacyOperationFailed: '개인정보 작업이 완료되지 않았습니다. 안전하게 다시 시도하세요.',
    readDocument: '읽기', register: '계정 만들기', registrationComplete: '계정 생성 완료', registrationFailed: '가입에 실패했습니다. 인증 또는 약관 버전이 만료되었을 수 있습니다.', registrationLoginNext: '새 계정으로 로그인하세요.', registrationUnavailable: '현재 사이트에서는 가입할 수 없습니다.', required: '필수', requestErasure: '계정 삭제 요청', retentionAcknowledgement: '법적 기록이 비식별 상태로 만료일까지 남는 것을 이해합니다.', sendCode: '인증 코드 보내기', submitErasure: '삭제 요청 제출',
    thirdPartyFollowUp: '제3자 처리는 별도로 추적하며 즉시 삭제되었다고 표시하지 않습니다.', typeDelete: 'DELETE 입력', verificationCode: '인증 코드', verify: '인증', verifyContact: '이메일 또는 휴대전화 인증',
  },
} as const;

const paymentMessages = {
  'zh-TW': {
    amount: '金額', buyDrama: '購買整部短劇', buyEpisode: '購買本集', checkPrice: '查詢價格',
    checkoutUnavailable: '暫時無法啟動結帳，未自動改用其他付款路由。', currency: '幣種', locked: '本集尚未取得觀看權限。', orderNumber: '訂單號',
    paymentCancelled: '已取消結帳', paymentChecking: '正在確認付款', paymentCheckError: '暫時無法更新訂單狀態。',
    paymentFailed: '付款未完成。', paymentPaid: '付款已確認', paymentSignIn: '請先登入再付款。', paymentUnavailable: '目前網站暫不可使用付款。',
    payWithStripe: '前往 Stripe 付款', priceChanged: '伺服器價格已變更，請再次確認。', redirecting: '正在開啟 Stripe…',
    serverPriceNotice: '金額來自伺服器，本頁無法修改。', sessionIdIgnored: '返回參數不代表成功，只信任伺服器訂單狀態。',
    status: '狀態', stripeHosted: '由 Stripe 託管安全結帳，本頁不收集卡號。', webhookPending: 'Stripe 確認可能需要片刻，本頁會安全更新。',
  },
  'fr-FR': {
    amount: 'Montant', buyDrama: 'Acheter la série', buyEpisode: 'Acheter cet épisode', checkPrice: 'Voir le prix',
    checkoutUnavailable: "Paiement indisponible. Aucun autre circuit n'a été utilisé.", currency: 'Devise', locked: 'Cet épisode est verrouillé.', orderNumber: 'Commande',
    paymentCancelled: 'Paiement annulé', paymentChecking: 'Vérification du paiement', paymentCheckError: 'Impossible d’actualiser la commande.',
    paymentFailed: 'Paiement non terminé.', paymentPaid: 'Paiement confirmé', paymentSignIn: 'Connectez-vous avant de payer.', paymentUnavailable: 'Le paiement est indisponible pour ce site.',
    payWithStripe: 'Continuer sur Stripe', priceChanged: 'Le prix serveur a changé. Confirmez-le à nouveau.', redirecting: 'Ouverture de Stripe…',
    serverPriceNotice: 'Le montant vient du serveur et ne peut pas être modifié ici.', sessionIdIgnored: "Les paramètres de retour ne prouvent pas le paiement ; seul l’état serveur fait foi.",
    status: 'Statut', stripeHosted: 'Paiement hébergé par Stripe ; aucune carte n’est collectée ici.', webhookPending: 'La confirmation Stripe peut prendre un instant. Cette page s’actualise en sécurité.',
  },
  'ja-JP': {
    amount: '金額', buyDrama: '全話を購入', buyEpisode: 'このエピソードを購入', checkPrice: '価格を確認',
    checkoutUnavailable: '決済を開始できません。別の決済経路に自動切替していません。', currency: '通貨', locked: 'この話は未解放です。', orderNumber: '注文番号',
    paymentCancelled: '決済をキャンセルしました', paymentChecking: '決済確認中', paymentCheckError: '注文状態を更新できません。',
    paymentFailed: '決済は完了していません。', paymentPaid: '決済確認済み', paymentSignIn: '決済前にログインしてください。', paymentUnavailable: 'このサイトでは決済を利用できません。',
    payWithStripe: 'Stripe で支払う', priceChanged: 'サーバー価格が変更されました。再確認してください。', redirecting: 'Stripe を開いています…',
    serverPriceNotice: '金額はサーバーから取得し、ここでは変更できません。', sessionIdIgnored: '戻りパラメータではなく、サーバーの注文状態のみを信頼します。',
    status: '状態', stripeHosted: 'Stripe 托管決済です。この画面はカード情報を収集しません。', webhookPending: 'Stripe の確認に時間がかかる場合があります。安全に更新します。',
  },
  'ko-KR': {
    amount: '금액', buyDrama: '전체 구매', buyEpisode: '이 회차 구매', checkPrice: '가격 확인',
    checkoutUnavailable: '결제를 시작할 수 없습니다. 다른 결제 경로로 자동 전환하지 않았습니다.', currency: '통화', locked: '이 회차는 잠겨 있습니다.', orderNumber: '주문 번호',
    paymentCancelled: '결제 취소', paymentChecking: '결제 확인 중', paymentCheckError: '주문 상태를 새로고침할 수 없습니다.',
    paymentFailed: '결제가 완료되지 않았습니다.', paymentPaid: '결제 확인 완료', paymentSignIn: '결제 전 로그인하세요.', paymentUnavailable: '현재 사이트에서 결제를 사용할 수 없습니다.',
    payWithStripe: 'Stripe로 결제', priceChanged: '서버 가격이 변경되었습니다. 다시 확인하세요.', redirecting: 'Stripe 여는 중…',
    serverPriceNotice: '금액은 서버에서 제공하며 이 페이지에서 수정할 수 없습니다.', sessionIdIgnored: '리다이렉트 파라미터가 아닌 서버 주문 상태만 신뢰합니다.',
    status: '상태', stripeHosted: 'Stripe 호스팅 결제이며 이 페이지는 카드 정보를 수집하지 않습니다.', webhookPending: 'Stripe 확인에 잠시 시간이 걸릴 수 있으며 안전하게 새로고침합니다.',
  },
} as const;

const messages: Record<ContentLocale, Partial<Record<MessageKey, string>>> = {
  'en-US': en,
  'zh-CN': {
    account: '账户', accountSummary: '账户摘要', all: '全部', amount: '金额', autoPlay: '自动连播', back: '返回', buyDrama: '购买整部短剧', buyEpisode: '购买本集', categories: '分类', checkPrice: '查询价格', checkoutUnavailable: '暂无法发起收银，未自动改用其他支付路由。', completed: '已看完', continueWatching: '继续观看', currency: '币种', details: '详情', devices: '登录设备', empty: '暂无内容', episode: '第', episodes: '选集', error: '操作失败', favorite: '收藏', favorites: '收藏', fullScreen: '全屏', history: '历史', home: '首页', internal: '内部测试版 · 尚未公开上线', language: '语言', latest: '最新内容', loading: '加载中…', locked: '本集尚未获得观看权限。', login: '登录', loginHint: '仅支持密码登录；当前标签页关闭后不会保留登录状态。', logout: '退出登录', next: '下一页', noRemember: '不提供“记住登录”：关闭当前标签页会清除刷新会话。', orderNumber: '订单号', password: '密码', paymentCancelled: '已取消收银', paymentChecking: '正在确认支付', paymentCheckError: '暂时无法刷新订单状态。', paymentFailed: '支付未完成。', paymentPaid: '支付已确认', paymentSignIn: '请先登录再发起支付。', paymentUnavailable: '当前站点暂不可用支付。', payWithStripe: '前往 Stripe 支付', play: '播放', previewUnavailable: '试看媒体服务验收前，暂不开放试看。', previous: '上一页', priceChanged: '服务端价格已变化，请重新确认。', redirecting: '正在打开 Stripe…', refresh: '重试', registrationUnavailable: '法律条款同意记录接口完成前，暂不开放注册。', removeFavorite: '取消收藏', resumeAt: '续播位置', revoke: '下线设备', search: '搜索标题或简介', searchButton: '搜索', serverPriceNotice: '金额来自服务端，本页无法修改。', sessionIdIgnored: '回跳参数不代表支付成功，仅信任服务端订单状态。', signInRequired: '登录后才能使用此功能。', speed: '倍速', status: '状态', stripeHosted: '由 Stripe 托管安全收银，本页不收集卡号。', tags: '标签', username: '用户名、邮箱或手机号', verified: '已验证', watch: '观看', webhookPending: 'Stripe 确认可能需要片刻，本页会安全刷新。',
  },
  'zh-TW': {
    ...paymentMessages['zh-TW'],
    account: '帳戶', accountSummary: '帳戶摘要', all: '全部', autoPlay: '自動連播', back: '返回', categories: '分類', completed: '已看完', continueWatching: '繼續觀看', details: '詳情', devices: '登入裝置', empty: '暫無內容', episode: '第', episodes: '選集', error: '操作失敗', favorite: '收藏', favorites: '收藏', fullScreen: '全螢幕', history: '歷史', home: '首頁', internal: '內部測試版 · 尚未公開上線', language: '語言', latest: '最新內容', loading: '載入中…', locked: '本集尚未取得觀看權限。內部測試版暫不開放付款。', login: '登入', loginHint: '僅支援密碼登入；關閉目前分頁後不會保留登入狀態。', logout: '登出', next: '下一頁', noRemember: '不提供「記住登入」：關閉目前分頁會清除更新工作階段。', password: '密碼', paymentUnavailable: '真實付款流程接入前，不開放付款。', play: '播放', previewUnavailable: '試看媒體服務驗收前，暫不開放試看。', previous: '上一頁', refresh: '重試', registrationUnavailable: '法律條款同意記錄介面完成前，暫不開放註冊。', removeFavorite: '取消收藏', resumeAt: '續播位置', revoke: '下線裝置', search: '搜尋標題或簡介', searchButton: '搜尋', signInRequired: '登入後才能使用此功能。', speed: '倍速', tags: '標籤', username: '使用者名稱、電子郵件或手機', verified: '已驗證', watch: '觀看',
  },
  'fr-FR': {
    ...paymentMessages['fr-FR'],
    account: 'Compte', accountSummary: 'Résumé du compte', all: 'Tous', autoPlay: 'Lecture automatique', back: 'Retour', categories: 'Catégories', completed: 'Terminé', continueWatching: 'Continuer', details: 'Détails', devices: 'Appareils', empty: 'Aucun contenu', episode: 'Épisode', episodes: 'Épisodes', error: 'Une erreur est survenue', favorite: 'Favori', favorites: 'Favoris', fullScreen: 'Plein écran', history: 'Historique', home: 'Accueil', internal: 'Test interne · pas encore publié', language: 'Langue', latest: 'Nouveautés', loading: 'Chargement…', locked: "Cet épisode est verrouillé. Le paiement n'est pas disponible dans cette version interne.", login: 'Connexion', loginHint: 'Connexion par mot de passe uniquement. Cet onglet ne mémorise pas la session.', logout: 'Déconnexion', next: 'Suivant', noRemember: 'Pas de connexion persistante : fermer cet onglet efface la session.', password: 'Mot de passe', paymentUnavailable: "Paiement indisponible jusqu'à l'intégration du vrai parcours.", play: 'Lire', previewUnavailable: "Aperçu indisponible jusqu'à validation du service média.", previous: 'Précédent', refresh: 'Réessayer', registrationUnavailable: "Inscription fermée jusqu'à la gestion du consentement légal.", removeFavorite: 'Retirer', resumeAt: 'Reprendre à', revoke: 'Déconnecter', search: 'Rechercher titres ou descriptions', searchButton: 'Rechercher', signInRequired: 'Connectez-vous pour utiliser cette fonction.', speed: 'Vitesse', tags: 'Tags', username: "Nom d’utilisateur, e-mail ou téléphone", verified: 'Vérifié', watch: 'Regarder',
  },
  'ja-JP': {
    ...paymentMessages['ja-JP'],
    account: 'アカウント', accountSummary: 'アカウント概要', all: 'すべて', autoPlay: '自動再生', back: '戻る', categories: 'カテゴリー', completed: '視聴済み', continueWatching: '続きを見る', details: '詳細', devices: '端末', empty: 'コンテンツがありません', episode: '第', episodes: 'エピソード', error: 'エラーが発生しました', favorite: 'お気に入り', favorites: 'お気に入り', fullScreen: '全画面', history: '履歴', home: 'ホーム', internal: '内部テスト版・未公開', language: '言語', latest: '新着', loading: '読み込み中…', locked: 'この話はロックされています。内部テスト版では決済できません。', login: 'ログイン', loginHint: 'パスワードログインのみ。このタブではログインを記憶しません。', logout: 'ログアウト', next: '次へ', noRemember: '「ログインを記憶」はありません。タブを閉じると更新セッションが消去されます。', password: 'パスワード', paymentUnavailable: '正式な決済フロー接続まで決済は利用できません。', play: '再生', previewUnavailable: 'プレビュー用メディアの承認まで試聴できません。', previous: '前へ', refresh: '再試行', registrationUnavailable: '法的同意記録APIの完成まで登録はできません。', removeFavorite: 'お気に入り解除', resumeAt: '続き', revoke: '端末をログアウト', search: 'タイトル・概要を検索', searchButton: '検索', signInRequired: 'ログインが必要です。', speed: '速度', tags: 'タグ', username: 'ユーザー名・メール・電話番号', verified: '確認済み', watch: '見る',
  },
  'ko-KR': {
    ...paymentMessages['ko-KR'],
    account: '계정', accountSummary: '계정 요약', all: '전체', autoPlay: '자동 재생', back: '뒤로', categories: '카테고리', completed: '완료', continueWatching: '이어보기', details: '상세', devices: '기기', empty: '콘텐츠가 없습니다', episode: '회', episodes: '회차', error: '오류가 발생했습니다', favorite: '찜', favorites: '찜 목록', fullScreen: '전체 화면', history: '시청 기록', home: '홈', internal: '내부 테스트 · 미출시', language: '언어', latest: '최신 콘텐츠', loading: '불러오는 중…', locked: '이 회차는 잠겨 있습니다. 내부 테스트 버전에서는 결제를 사용할 수 없습니다.', login: '로그인', loginHint: '비밀번호 로그인만 지원합니다. 이 탭은 로그인을 기억하지 않습니다.', logout: '로그아웃', next: '다음', noRemember: '로그인 기억 기능이 없습니다. 탭을 닫으면 갱신 세션이 삭제됩니다.', password: '비밀번호', paymentUnavailable: '실제 결제 흐름 연동 전에는 결제할 수 없습니다.', play: '재생', previewUnavailable: '미리보기 미디어 서비스 승인 전에는 사용할 수 없습니다.', previous: '이전', refresh: '다시 시도', registrationUnavailable: '법적 동의 기록 API가 준비될 때까지 가입할 수 없습니다.', removeFavorite: '찜 해제', resumeAt: '이어보기 위치', revoke: '기기 로그아웃', search: '제목 또는 소개 검색', searchButton: '검색', signInRequired: '로그인이 필요합니다.', speed: '배속', tags: '태그', username: '사용자명, 이메일 또는 전화번호', verified: '인증됨', watch: '보기',
  },
};

export const localeNames: Record<ContentLocale, string> = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', 'en-US': 'English', 'fr-FR': 'Français', 'ja-JP': '日本語', 'ko-KR': '한국어',
};

export function translate(locale: ContentLocale, key: MessageKey): string {
  const payment = locale === 'en-US' || locale === 'zh-CN'
    ? undefined
    : paymentMessages[locale][key as keyof (typeof paymentMessages)[typeof locale]];
  const privacy = locale === 'en-US'
    ? undefined
    : privacyMessages[locale][key as keyof (typeof privacyMessages)[typeof locale]];
  return privacy ?? payment ?? messages[locale]?.[key] ?? en[key];
}

export function isContentLocale(value: unknown): value is ContentLocale {
  return typeof value === 'string' && value in messages;
}

export function translationKeys(locale: ContentLocale): string[] {
  return Object.keys(en).filter((key) => Boolean(translate(locale, key as MessageKey)));
}
