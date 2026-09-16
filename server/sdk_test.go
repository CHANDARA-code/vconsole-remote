package main

import "testing"

func TestETagMatches(t *testing.T) {
	const tag = `"93bb7cc6717123f0"`

	cases := []struct {
		name   string
		header string
		want   bool
	}{
		{"empty header", "", false},
		{"exact", `"93bb7cc6717123f0"`, true},
		// Cloudflare and other recompressing proxies hand the client a weak
		// tag for what the origin sent strong; this is the case that made the
		// original exact-string comparison never hit.
		{"weakened by proxy", `W/"93bb7cc6717123f0"`, true},
		{"list containing the tag", `"other", W/"93bb7cc6717123f0"`, true},
		{"list without the tag", `"aaa", W/"bbb"`, false},
		{"wildcard", "*", true},
		{"padded wildcard", "  *  ", true},
		{"different tag", `"0000000000000000"`, false},
		{"prefix of the tag is not a match", `"93bb7cc6"`, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := etagMatches(tc.header, tag); got != tc.want {
				t.Errorf("etagMatches(%q, %q) = %v, want %v", tc.header, tag, got, tc.want)
			}
		})
	}
}
