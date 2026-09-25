package auth

import (
	"errors"
	"unicode"

	"golang.org/x/crypto/bcrypt"

	"quadrangis/internal/i18n"
)

// HashPassword membuat hash bcrypt.
func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), 12)
	return string(b), err
}

// CheckPassword mencocokkan kata sandi dengan hash.
func CheckPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// ValidatePassword memastikan kata sandi cukup kuat; pesan dalam bahasa yang diminta.
func ValidatePassword(lang i18n.Lang, p string) error {
	if len(p) < 8 {
		return errors.New(i18n.T(lang, "auth.pw_too_short"))
	}
	var hasLetter, hasDigit bool
	for _, r := range p {
		switch {
		case unicode.IsLetter(r):
			hasLetter = true
		case unicode.IsDigit(r):
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return errors.New(i18n.T(lang, "auth.pw_letters_digits"))
	}
	return nil
}
